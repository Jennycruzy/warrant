use ark_bls12_381::{Fq, Fq2, G1Affine, G2Affine};
use ark_serialize::CanonicalSerialize;
use num_bigint::BigUint;
use serde::Deserialize;
use std::{fs, str::FromStr};

#[derive(Deserialize)]
struct VerificationKeyJson {
    vk_alpha_1: [String; 3],
    vk_beta_2: [[String; 2]; 3],
    vk_gamma_2: [[String; 2]; 3],
    vk_delta_2: [[String; 2]; 3],
    #[serde(rename = "IC")]
    ic: Vec<[String; 3]>,
    #[serde(rename = "nPublic")]
    n_public: usize,
}

#[derive(Deserialize)]
struct ProofJson {
    pi_a: [String; 3],
    pi_b: [[String; 2]; 3],
    pi_c: [String; 3],
}

type PublicSignalsJson = Vec<String>;

fn g1_bytes(x: &str, y: &str) -> Vec<u8> {
    let p = G1Affine::new(
        Fq::from_str(x).expect("invalid G1 x"),
        Fq::from_str(y).expect("invalid G1 y"),
    );
    let mut out = Vec::new();
    p.serialize_uncompressed(&mut out)
        .expect("failed to serialize G1");
    out
}

fn g2_bytes(x1: &str, x2: &str, y1: &str, y2: &str) -> Vec<u8> {
    let x = Fq2::new(
        Fq::from_str(x1).expect("invalid G2 x1"),
        Fq::from_str(x2).expect("invalid G2 x2"),
    );
    let y = Fq2::new(
        Fq::from_str(y1).expect("invalid G2 y1"),
        Fq::from_str(y2).expect("invalid G2 y2"),
    );
    let p = G2Affine::new(x, y);
    let mut out = Vec::new();
    p.serialize_uncompressed(&mut out)
        .expect("failed to serialize G2");
    out
}

fn parse_u256_be(signal: &str) -> [u8; 32] {
    let n = BigUint::parse_bytes(signal.as_bytes(), 10).expect("invalid public signal");
    let mut raw = n.to_bytes_be();
    if raw.len() > 32 {
        panic!("public signal exceeds 256 bits");
    }
    if raw.len() < 32 {
        let mut padded = vec![0u8; 32 - raw.len()];
        padded.append(&mut raw);
        raw = padded;
    }
    raw.try_into().expect("invalid 32-byte conversion")
}

fn vk_hex(path: &str) -> String {
    let src = fs::read_to_string(path).expect("failed to read vk json");
    let vk: VerificationKeyJson = serde_json::from_str(&src).expect("invalid vk json");

    if vk.ic.len() != vk.n_public + 1 {
        panic!("IC length does not match nPublic + 1");
    }

    let mut out = Vec::new();
    out.extend(g1_bytes(&vk.vk_alpha_1[0], &vk.vk_alpha_1[1]));
    out.extend(g2_bytes(
        &vk.vk_beta_2[0][0],
        &vk.vk_beta_2[0][1],
        &vk.vk_beta_2[1][0],
        &vk.vk_beta_2[1][1],
    ));
    out.extend(g2_bytes(
        &vk.vk_gamma_2[0][0],
        &vk.vk_gamma_2[0][1],
        &vk.vk_gamma_2[1][0],
        &vk.vk_gamma_2[1][1],
    ));
    out.extend(g2_bytes(
        &vk.vk_delta_2[0][0],
        &vk.vk_delta_2[0][1],
        &vk.vk_delta_2[1][0],
        &vk.vk_delta_2[1][1],
    ));

    out.extend((vk.ic.len() as u32).to_be_bytes());
    for point in vk.ic {
        out.extend(g1_bytes(&point[0], &point[1]));
    }

    hex::encode(out)
}

fn proof_hex(path: &str) -> String {
    let src = fs::read_to_string(path).expect("failed to read proof json");
    let proof: ProofJson = serde_json::from_str(&src).expect("invalid proof json");

    let mut out = Vec::new();
    out.extend(g1_bytes(&proof.pi_a[0], &proof.pi_a[1]));
    out.extend(g2_bytes(
        &proof.pi_b[0][0],
        &proof.pi_b[0][1],
        &proof.pi_b[1][0],
        &proof.pi_b[1][1],
    ));
    out.extend(g1_bytes(&proof.pi_c[0], &proof.pi_c[1]));

    hex::encode(out)
}

fn public_hex(path: &str) -> String {
    let src = fs::read_to_string(path).expect("failed to read public json");
    let signals: PublicSignalsJson = serde_json::from_str(&src).expect("invalid public json");

    let mut out = Vec::new();
    out.extend((signals.len() as u32).to_be_bytes());
    for s in signals {
        out.extend(parse_u256_be(&s));
    }

    hex::encode(out)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let kind = args
        .next()
        .expect("usage: circom-to-soroban-hex <vk|proof|public> <json-file>");
    let path = args
        .next()
        .expect("usage: circom-to-soroban-hex <vk|proof|public> <json-file>");

    let hex = match kind.as_str() {
        "vk" => vk_hex(&path),
        "proof" => proof_hex(&path),
        "public" => public_hex(&path),
        _ => panic!("unknown kind: {kind}"),
    };

    println!("{hex}");
}
