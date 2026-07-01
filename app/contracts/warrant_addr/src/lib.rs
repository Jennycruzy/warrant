#![no_std]

//! WARRANT custody contract.
//!
//! Holds a balance of a token (a Stellar Asset Contract) and releases it ONLY
//! when a Groth16 proof shows the settlement obeys the pre-committed private
//! mandate and extends the on-chain state-root chain. The mandate and the book
//! never appear on-chain; only the commitment, the current state root, the
//! proof, and the public action (amount + recipient type/key bytes) are visible.
//!
//! Public signal order (must match mandate_oracle_allow_addr.circom):
//!   [0] policyCommitment  [1] prevStateRoot  [2] nextStateRoot
//!   [3] amount            [4] recipientType  [5] recipientHi
//!   [6] recipientLo       [7] price

use soroban_sdk::{
    address_payload::AddressPayload,
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Fr, G1Affine, G2Affine, G1_SERIALIZED_SIZE, G2_SERIALIZED_SIZE},
    token, vec, Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec, U256,
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
    OracleKeyNotSet = 14,
    PriceMismatch = 15,
    PriceUnavailable = 16,
    PriceOutOfRange = 17,
    RecipientMismatch = 18,
    RecipientTypeMismatch = 19,
}

// SEP-40 oracle types (must match the Reflector oracle contract's interface so
// the cross-contract return value decodes correctly).
#[contracttype]
#[derive(Clone)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    Vk,
    PolicyCommitment,
    StateRoot,
    OraclePubKey,
}

const N_PUBLIC_MANDATE: u32 = 7;
const N_PUBLIC_ORACLE: u32 = 8;

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
        Ok(Self {
            alpha,
            beta,
            gamma,
            delta,
            ic,
        })
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

fn verify_proof(
    env: &Env,
    vk: VerificationKey,
    proof: Proof,
    signals: Vec<Fr>,
) -> Result<bool, Error> {
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

fn signal_to_bit(arr: &[u8; 32]) -> Result<u32, Error> {
    if arr[0..31] != [0u8; 31] {
        return Err(Error::RecipientTypeMismatch);
    }
    if arr[31] > 1 {
        return Err(Error::RecipientTypeMismatch);
    }
    Ok(arr[31] as u32)
}

fn signal_to_u128(arr: &[u8; 32]) -> Result<u128, Error> {
    if arr[0..16] != [0u8; 16] {
        return Err(Error::RecipientMismatch);
    }
    let mut b = [0u8; 16];
    b.copy_from_slice(&arr[16..32]);
    Ok(u128::from_be_bytes(b))
}

fn signal_to_u64(arr: &[u8; 32]) -> Result<u64, Error> {
    if arr[0..24] != [0u8; 24] {
        return Err(Error::AmountOutOfRange);
    }
    let mut b = [0u8; 8];
    b.copy_from_slice(&arr[24..32]);
    Ok(u64::from_be_bytes(b))
}

fn price_message(env: &Env, price: u64, timestamp: u64) -> Bytes {
    let mut msg = Bytes::new(env);
    for b in price.to_be_bytes() {
        msg.push_back(b);
    }
    for b in timestamp.to_be_bytes() {
        msg.push_back(b);
    }
    msg
}

fn u128_from_be_16(bytes: &[u8]) -> u128 {
    let mut out = [0u8; 16];
    out.copy_from_slice(bytes);
    u128::from_be_bytes(out)
}

fn address_identity(address: &Address) -> Result<(u32, u128, u128), Error> {
    let (recipient_type, bytes) = match address.to_payload().ok_or(Error::RecipientMismatch)? {
        AddressPayload::AccountIdPublicKeyEd25519(bytes) => (0, bytes),
        AddressPayload::ContractIdHash(bytes) => (1, bytes),
    };
    let raw = bytes.to_array();
    Ok((
        recipient_type,
        u128_from_be_16(&raw[0..16]),
        u128_from_be_16(&raw[16..32]),
    ))
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

    /// Store the oracle Ed25519 public key. Admin only.
    pub fn set_oracle(env: Env, public_key: BytesN<32>) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::OraclePubKey, &public_key);
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
    /// `amount` of the token to the exact proven recipient address.
    pub fn settle(
        env: Env,
        proof_bytes: Bytes,
        pub_signals_bytes: Bytes,
        recipient: Address,
    ) -> Result<(), Error> {
        Self::settle_checked(
            env,
            proof_bytes,
            pub_signals_bytes,
            recipient,
            N_PUBLIC_MANDATE,
            None,
        )
    }

    /// Release funds for an oracle-marked settlement. The contract authenticates
    /// `price,timestamp` under the stored oracle key and requires `price` to be
    /// the exact eighth public signal verified by the Groth16 proof.
    pub fn settle_with_price(
        env: Env,
        proof_bytes: Bytes,
        pub_signals_bytes: Bytes,
        recipient: Address,
        price: u64,
        timestamp: u64,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        let oracle_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::OraclePubKey)
            .ok_or(Error::OracleKeyNotSet)?;
        let msg = price_message(&env, price, timestamp);
        env.crypto().ed25519_verify(&oracle_key, &msg, &signature);
        Self::settle_checked(
            env,
            proof_bytes,
            pub_signals_bytes,
            recipient,
            N_PUBLIC_ORACLE,
            Some(price),
        )
    }

    /// Release funds for a settlement priced by the LIVE Reflector oracle (SEP-40).
    /// Instead of an admin-signed price report, the contract performs a cross-contract
    /// call to `reflector.lastprice(Other(asset))` and requires that exact on-chain
    /// price to be the eighth public signal verified by the Groth16 proof. No matching
    /// live price, no settlement.
    pub fn settle_with_reflector(
        env: Env,
        proof_bytes: Bytes,
        pub_signals_bytes: Bytes,
        recipient: Address,
        reflector: Address,
        asset: Symbol,
    ) -> Result<(), Error> {
        let query = Asset::Other(asset);
        let pd: Option<PriceData> = env.invoke_contract(
            &reflector,
            &Symbol::new(&env, "lastprice"),
            vec![&env, query.into_val(&env)],
        );
        let pd = pd.ok_or(Error::PriceUnavailable)?;
        if pd.price <= 0 || pd.price > u64::MAX as i128 {
            return Err(Error::PriceOutOfRange);
        }
        let price = pd.price as u64;
        Self::settle_checked(
            env,
            proof_bytes,
            pub_signals_bytes,
            recipient,
            N_PUBLIC_ORACLE,
            Some(price),
        )
    }

    fn settle_checked(
        env: Env,
        proof_bytes: Bytes,
        pub_signals_bytes: Bytes,
        recipient: Address,
        expected_public_count: u32,
        expected_price: Option<u64>,
    ) -> Result<(), Error> {
        // Must be initialized.
        let _admin = Self::admin(&env)?;

        // (1) well-formed public signals.
        let mut pos = 0u32;
        let count = u32::from_be_bytes(take::<4>(
            &pub_signals_bytes,
            &mut pos,
            Error::MalformedPublicSignals,
        )?);
        if count != expected_public_count {
            return Err(Error::WrongPublicSignalCount);
        }

        // Extract the raw signals from the SAME bytes that step (4) verifies.
        let policy = signal_array(&pub_signals_bytes, 0)?;
        let prev_root = signal_array(&pub_signals_bytes, 1)?;
        let next_root = signal_array(&pub_signals_bytes, 2)?;
        let amount = signal_to_i128(&signal_array(&pub_signals_bytes, 3)?)?;
        let recipient_type = signal_to_bit(&signal_array(&pub_signals_bytes, 4)?)?;
        let recipient_hi = signal_to_u128(&signal_array(&pub_signals_bytes, 5)?)?;
        let recipient_lo = signal_to_u128(&signal_array(&pub_signals_bytes, 6)?)?;
        if let Some(price) = expected_price {
            if signal_to_u64(&signal_array(&pub_signals_bytes, 7)?)? != price {
                return Err(Error::PriceMismatch);
            }
        }

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

        // Compare only plain values read from the verified public-signal bytes.
        let (actual_type, actual_hi, actual_lo) = address_identity(&recipient)?;
        if actual_type != recipient_type {
            return Err(Error::RecipientTypeMismatch);
        }
        if actual_hi != recipient_hi || actual_lo != recipient_lo {
            return Err(Error::RecipientMismatch);
        }

        // Advance the state root, then transfer.
        env.storage()
            .instance()
            .set(&DataKey::StateRoot, &BytesN::from_array(&env, &next_root));
        env.storage().instance().extend_ttl(50_000, 100_000);

        let token: Address = Self::token(&env)?;
        token::TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );
        Ok(())
    }

    // ---- read-only getters for the UI ----

    pub fn current_state_root(env: Env) -> Result<BytesN<32>, Error> {
        env.storage()
            .instance()
            .get(&DataKey::StateRoot)
            .ok_or(Error::NotInitialized)
    }

    pub fn policy_commitment(env: Env) -> Result<BytesN<32>, Error> {
        env.storage()
            .instance()
            .get(&DataKey::PolicyCommitment)
            .ok_or(Error::NotInitialized)
    }

    pub fn get_token(env: Env) -> Result<Address, Error> {
        Self::token(&env)
    }

    // ---- internal helpers ----

    fn admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    fn token(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    const ACCOUNT_STRKEY: &str = "GAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX";
    const ACCOUNT_HI: u128 = 5233100606242806050955395731361295;
    const ACCOUNT_LO: u128 = 21356283574076891493948969979685445151;
    const CONTRACT_STRKEY: &str = "CD7757P47P5PT6HX6327J47S6HYO73XN5TV6V2PI47TOLZHD4LQ6BAYK";
    const CONTRACT_HI: u128 = 340277133820332220657323652036036850160;
    const CONTRACT_LO: u128 = 318926083346861571969425637452082766304;

    fn addresses(env: &Env) -> (Address, Address, Address) {
        (
            Address::generate(env),
            Address::generate(env),
            Address::generate(env),
        )
    }

    fn bytes_with_count(env: &Env, count: u32) -> Bytes {
        let mut bytes = Bytes::new(env);
        for b in count.to_be_bytes() {
            bytes.push_back(b);
        }
        bytes
    }

    fn contract_id(env: &Env) -> Address {
        env.register(Warrant, ())
    }

    #[test]
    fn init_sets_policy_root_token_and_rejects_second_init() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = contract_id(&env);
        let (admin, token, _) = addresses(&env);
        let policy = BytesN::from_array(&env, &[1u8; 32]);
        let root = BytesN::from_array(&env, &[2u8; 32]);

        assert_eq!(
            env.as_contract(&cid, || {
                Warrant::init(
                    env.clone(),
                    admin.clone(),
                    token.clone(),
                    policy.clone(),
                    root.clone(),
                )
            }),
            Ok(())
        );
        assert_eq!(
            env.as_contract(&cid, || Warrant::policy_commitment(env.clone())),
            Ok(policy.clone())
        );
        assert_eq!(
            env.as_contract(&cid, || Warrant::current_state_root(env.clone())),
            Ok(root)
        );
        assert_eq!(
            env.as_contract(&cid, || Warrant::get_token(env.clone())),
            Ok(token.clone())
        );

        let other_root = BytesN::from_array(&env, &[3u8; 32]);
        assert_eq!(
            env.as_contract(&cid, || Warrant::init(
                env.clone(),
                admin,
                token,
                policy,
                other_root
            )),
            Err(Error::AlreadyInitialized)
        );
    }

    #[test]
    fn admin_methods_fail_before_init() {
        let env = Env::default();
        let cid = contract_id(&env);

        assert_eq!(
            env.as_contract(&cid, || Warrant::set_vk(env.clone(), Bytes::new(&env))),
            Err(Error::NotInitialized)
        );
        assert_eq!(
            env.as_contract(&cid, || Warrant::set_oracle(
                env.clone(),
                BytesN::from_array(&env, &[0u8; 32])
            )),
            Err(Error::NotInitialized)
        );
    }

    #[test]
    fn malformed_verification_key_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = contract_id(&env);
        let (admin, token, _) = addresses(&env);
        env.as_contract(&cid, || {
            Warrant::init(
                env.clone(),
                admin,
                token,
                BytesN::from_array(&env, &[1u8; 32]),
                BytesN::from_array(&env, &[2u8; 32]),
            )
        })
        .unwrap();

        let mut vk = Bytes::new(&env);
        vk.push_back(42);
        assert_eq!(
            env.as_contract(&cid, || Warrant::set_vk(env.clone(), vk)),
            Err(Error::MalformedVerifyingKey)
        );
    }

    #[test]
    fn settle_rejects_wrong_public_signal_count_before_verifying_key_lookup() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = contract_id(&env);
        let (admin, token, _) = addresses(&env);
        env.as_contract(&cid, || {
            Warrant::init(
                env.clone(),
                admin,
                token,
                BytesN::from_array(&env, &[1u8; 32]),
                BytesN::from_array(&env, &[2u8; 32]),
            )
        })
        .unwrap();

        assert_eq!(
            env.as_contract(&cid, || Warrant::settle(
                env.clone(),
                Bytes::new(&env),
                bytes_with_count(&env, 6),
                Address::generate(&env)
            )),
            Err(Error::WrongPublicSignalCount)
        );
        assert_eq!(
            env.as_contract(&cid, || {
                Warrant::settle_with_price(
                    env.clone(),
                    Bytes::new(&env),
                    bytes_with_count(&env, 7),
                    Address::generate(&env),
                    10,
                    1,
                    BytesN::from_array(&env, &[0u8; 64]),
                )
            }),
            Err(Error::OracleKeyNotSet)
        );
    }

    #[test]
    fn signal_range_decoders_reject_oversized_values() {
        let mut amount = [0u8; 32];
        amount[15] = 1;
        assert_eq!(signal_to_i128(&amount), Err(Error::AmountOutOfRange));

        let mut recipient_type = [0u8; 32];
        recipient_type[31] = 2;
        assert_eq!(
            signal_to_bit(&recipient_type),
            Err(Error::RecipientTypeMismatch)
        );

        let mut recipient_limb = [0u8; 32];
        recipient_limb[15] = 1;
        assert_eq!(
            signal_to_u128(&recipient_limb),
            Err(Error::RecipientMismatch)
        );

        let mut price = [0u8; 32];
        price[23] = 1;
        assert_eq!(signal_to_u64(&price), Err(Error::AmountOutOfRange));
    }

    #[test]
    fn address_identity_extracts_account_and_contract() {
        let env = Env::default();
        let account = Address::from_str(&env, ACCOUNT_STRKEY);
        let contract = Address::from_str(&env, CONTRACT_STRKEY);

        assert_eq!(address_identity(&account), Ok((0, ACCOUNT_HI, ACCOUNT_LO)));
        assert_eq!(
            address_identity(&contract),
            Ok((1, CONTRACT_HI, CONTRACT_LO))
        );
    }
}
