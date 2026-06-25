#![no_std]

//! WARRANT custody contract.
//!
//! Holds a balance of a token (a Stellar Asset Contract) and releases it ONLY
//! when a Groth16 proof shows the settlement obeys the pre-committed private
//! mandate and extends the on-chain state-root chain. The mandate and the book
//! never appear on-chain; only the commitment, the current state root, the
//! proof, and the public action (amount + recipient id) are visible.
//!
//! Public signal order (must match mandate.circom):
//!   [0] policyCommitment  [1] prevStateRoot  [2] nextStateRoot
//!   [3] amount            [4] recipient id

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Fr, G1Affine, G2Affine, G1_SERIALIZED_SIZE, G2_SERIALIZED_SIZE},
    token, vec, Address, Bytes, BytesN, Env, Vec, U256,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    MalformedVerifyingKey = 3,
    VerificationKeyNotSet = 4,
    MalformedProof = 5,
    MalformedPublicSignals = 6,
    WrongPublicSignalCount = 7,
    CommitmentMismatch = 8,
    StaleStateRoot = 9,
    ProofInvalid = 10,
    RecipientNotRegistered = 11,
    AmountOutOfRange = 12,
    RecipientIdOutOfRange = 13,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    Vk,
    PolicyCommitment,
    StateRoot,
    Recipient(u32),
}

// Number of public signals the mandate circuit exposes.
const N_PUBLIC: u32 = 5;

// ---------------------------------------------------------------------------
// Groth16 verification primitives (BLS12-381). Layout matches the reference
// encoder: G1 = 96 bytes uncompressed, G2 = 192 bytes, each signal = 32 bytes.
// ---------------------------------------------------------------------------

struct VerificationKey {
    alpha: G1Affine,
    beta: G2Affine,
    gamma: G2Affine,
    delta: G2Affine,
    ic: Vec<G1Affine>,
}

struct Proof {
    a: G1Affine,
    b: G2Affine,
    c: G1Affine,
}

fn take<const N: usize>(bytes: &Bytes, pos: &mut u32, err: Error) -> Result<[u8; N], Error> {
    let end = pos.checked_add(N as u32).ok_or(err)?;
    if end > bytes.len() {
        return Err(err);
    }
    let mut arr = [0u8; N];
    bytes.slice(*pos..end).copy_into_slice(&mut arr);
    *pos = end;
    Ok(arr)
}

impl VerificationKey {
    fn from_bytes(env: &Env, bytes: &Bytes) -> Result<Self, Error> {
        let mut pos = 0u32;
        let e = Error::MalformedVerifyingKey;
        let alpha = G1Affine::from_array(env, &take::<G1_SERIALIZED_SIZE>(bytes, &mut pos, e)?);
        let beta = G2Affine::from_array(env, &take::<G2_SERIALIZED_SIZE>(bytes, &mut pos, e)?);
        let gamma = G2Affine::from_array(env, &take::<G2_SERIALIZED_SIZE>(bytes, &mut pos, e)?);
        let delta = G2Affine::from_array(env, &take::<G2_SERIALIZED_SIZE>(bytes, &mut pos, e)?);

        let ic_len = u32::from_be_bytes(take::<4>(bytes, &mut pos, e)?);
        let mut ic = Vec::new(env);
        for _ in 0..ic_len {
            ic.push_back(G1Affine::from_array(
                env,
                &take::<G1_SERIALIZED_SIZE>(bytes, &mut pos, e)?,
            ));
        }
        if pos != bytes.len() || ic_len == 0 {
            return Err(e);
        }
        Ok(Self { alpha, beta, gamma, delta, ic })
    }
}

impl Proof {
    fn from_bytes(env: &Env, bytes: &Bytes) -> Result<Self, Error> {
        let mut pos = 0u32;
        let e = Error::MalformedProof;
        let a = G1Affine::from_array(env, &take::<G1_SERIALIZED_SIZE>(bytes, &mut pos, e)?);
        let b = G2Affine::from_array(env, &take::<G2_SERIALIZED_SIZE>(bytes, &mut pos, e)?);
        let c = G1Affine::from_array(env, &take::<G1_SERIALIZED_SIZE>(bytes, &mut pos, e)?);
        if pos != bytes.len() {
            return Err(e);
        }
        Ok(Self { a, b, c })
    }
}

// Parse the length-prefixed public signals into field elements.
fn public_signals(env: &Env, bytes: &Bytes) -> Result<Vec<Fr>, Error> {
    let mut pos = 0u32;
    let e = Error::MalformedPublicSignals;
    let len = u32::from_be_bytes(take::<4>(bytes, &mut pos, e)?);
    let mut signals = Vec::new(env);
    for _ in 0..len {
        let arr = take::<32>(bytes, &mut pos, e)?;
        let u = U256::from_be_bytes(env, &Bytes::from_array(env, &arr));
        signals.push_back(Fr::from_u256(u));
    }
    if pos != bytes.len() {
        return Err(e);
    }
    Ok(signals)
}

fn verify_proof(env: &Env, vk: VerificationKey, proof: Proof, signals: Vec<Fr>) -> Result<bool, Error> {
    if signals.len() + 1 != vk.ic.len() {
        return Err(Error::MalformedVerifyingKey);
    }
    let bls = env.crypto().bls12_381();
    let mut vk_x = vk.ic.get(0).unwrap();
    for (s, v) in signals.iter().zip(vk.ic.iter().skip(1)) {
        let prod = bls.g1_mul(&v, &s);
        vk_x = bls.g1_add(&vk_x, &prod);
    }
    let neg_a = -proof.a;
    let vp1 = vec![env, neg_a, vk.alpha, vk_x, proof.c];
    let vp2 = vec![env, proof.b, vk.beta, vk.gamma, vk.delta];
    Ok(bls.pairing_check(vp1, vp2))
}

// ---------------------------------------------------------------------------
// Raw public-signal access. These read the SAME bytes that verify_proof checks,
// so the values compared against storage are bound to the verified proof.
// ---------------------------------------------------------------------------

// Extract the i-th 32-byte public signal from the length-prefixed blob.
fn signal_array(bytes: &Bytes, i: u32) -> Result<[u8; 32], Error> {
    let start = 4u32
        .checked_add(i.checked_mul(32).ok_or(Error::MalformedPublicSignals)?)
        .ok_or(Error::MalformedPublicSignals)?;
    let mut pos = start;
    take::<32>(bytes, &mut pos, Error::MalformedPublicSignals)
}

// A 32-byte big-endian signal that must fit in 128 bits (top 16 bytes zero),
// interpreted as a non-negative i128 amount.
fn signal_to_i128(arr: &[u8; 32]) -> Result<i128, Error> {
    let mut hi = [0u8; 16];
    hi.copy_from_slice(&arr[0..16]);
    if hi != [0u8; 16] {
        return Err(Error::AmountOutOfRange);
    }
    let mut lo = [0u8; 16];
    lo.copy_from_slice(&arr[16..32]);
    let v = u128::from_be_bytes(lo);
    if v > i128::MAX as u128 {
        return Err(Error::AmountOutOfRange);
    }
    Ok(v as i128)
}

// A 32-byte big-endian signal that must fit in 32 bits, used as a recipient id.
fn signal_to_u32(arr: &[u8; 32]) -> Result<u32, Error> {
    if arr[0..28] != [0u8; 28] {
        return Err(Error::RecipientIdOutOfRange);
    }
    let mut b = [0u8; 4];
    b.copy_from_slice(&arr[28..32]);
    Ok(u32::from_be_bytes(b))
}

#[contract]
pub struct Warrant;

#[contractimpl]
impl Warrant {
    /// One-time setup: bind the admin, the token, the mandate commitment, and the
    /// genesis state root.
    pub fn init(
        env: Env,
        admin: Address,
        token: Address,
        policy_commitment: BytesN<32>,
        initial_state_root: BytesN<32>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Token, &token);
        s.set(&DataKey::PolicyCommitment, &policy_commitment);
        s.set(&DataKey::StateRoot, &initial_state_root);
        s.extend_ttl(50_000, 100_000);
        Ok(())
    }

    /// Store the Groth16 verification key. Admin only; validated before storing.
    pub fn set_vk(env: Env, vk_bytes: Bytes) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        let _ = VerificationKey::from_bytes(&env, &vk_bytes)?;
        env.storage().instance().set(&DataKey::Vk, &vk_bytes);
        Ok(())
    }

    /// Map a public recipient id to a real on-chain address. Admin only.
    pub fn register_recipient(env: Env, id: u32, addr: Address) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        env.storage().instance().set(&DataKey::Recipient(id), &addr);
        Ok(())
    }

    /// Move `amount` of the token from `from` into the contract's custody.
    pub fn fund(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        let token: Address = Self::token(&env)?;
        token::TokenClient::new(&env, &token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        Ok(())
    }

    /// Release funds for a settlement. Releases ONLY if:
    ///   1. the public signals are well-formed (exactly N_PUBLIC),
    ///   2. the proven policyCommitment equals the stored commitment,
    ///   3. the proven prevStateRoot equals the current on-chain root,
    ///   4. the Groth16 proof verifies over those exact public-signal bytes.
    /// On success it advances the state root to nextStateRoot and transfers
    /// `amount` of the token to the registered recipient.
    pub fn settle(env: Env, proof_bytes: Bytes, pub_signals_bytes: Bytes) -> Result<(), Error> {
        // Must be initialized.
        let _admin = Self::admin(&env)?;

        // (1) well-formed public signals.
        let mut pos = 0u32;
        let count = u32::from_be_bytes(take::<4>(&pub_signals_bytes, &mut pos, Error::MalformedPublicSignals)?);
        if count != N_PUBLIC {
            return Err(Error::WrongPublicSignalCount);
        }

        // Extract the raw signals from the SAME bytes that step (4) verifies.
        let policy = signal_array(&pub_signals_bytes, 0)?;
        let prev_root = signal_array(&pub_signals_bytes, 1)?;
        let next_root = signal_array(&pub_signals_bytes, 2)?;
        let amount = signal_to_i128(&signal_array(&pub_signals_bytes, 3)?)?;
        let recipient_id = signal_to_u32(&signal_array(&pub_signals_bytes, 4)?)?;

        // (2) commitment must match.
        let stored_policy: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PolicyCommitment)
            .ok_or(Error::NotInitialized)?;
        if BytesN::from_array(&env, &policy) != stored_policy {
            return Err(Error::CommitmentMismatch);
        }

        // (3) prev root must be the current on-chain root.
        let stored_root: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::StateRoot)
            .ok_or(Error::NotInitialized)?;
        if BytesN::from_array(&env, &prev_root) != stored_root {
            return Err(Error::StaleStateRoot);
        }

        // (4) Groth16 verification over the exact same public-signal bytes.
        let vk_bytes: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::Vk)
            .ok_or(Error::VerificationKeyNotSet)?;
        let vk = VerificationKey::from_bytes(&env, &vk_bytes)?;
        let proof = Proof::from_bytes(&env, &proof_bytes)?;
        let signals = public_signals(&env, &pub_signals_bytes)?;
        if !verify_proof(&env, vk, proof, signals)? {
            return Err(Error::ProofInvalid);
        }

        // Resolve recipient id to a registered address before any state change.
        let to: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recipient(recipient_id))
            .ok_or(Error::RecipientNotRegistered)?;

        // Advance the state root, then transfer.
        env.storage()
            .instance()
            .set(&DataKey::StateRoot, &BytesN::from_array(&env, &next_root));
        env.storage().instance().extend_ttl(50_000, 100_000);

        let token: Address = Self::token(&env)?;
        token::TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        Ok(())
    }

    // ---- read-only getters for the UI ----

    pub fn current_state_root(env: Env) -> Result<BytesN<32>, Error> {
        env.storage().instance().get(&DataKey::StateRoot).ok_or(Error::NotInitialized)
    }

    pub fn policy_commitment(env: Env) -> Result<BytesN<32>, Error> {
        env.storage().instance().get(&DataKey::PolicyCommitment).ok_or(Error::NotInitialized)
    }

    pub fn get_token(env: Env) -> Result<Address, Error> {
        Self::token(&env)
    }

    pub fn recipient(env: Env, id: u32) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Recipient(id)).ok_or(Error::RecipientNotRegistered)
    }

    // ---- internal helpers ----

    fn admin(env: &Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
    }

    fn token(env: &Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Token).ok_or(Error::NotInitialized)
    }
}
