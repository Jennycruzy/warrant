#![no_std]

use soroban_sdk::{address_payload::AddressPayload, Address, BytesN};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecipientIdentity {
    pub recipient_type: u32,
    pub bytes: BytesN<32>,
    pub hi: u128,
    pub lo: u128,
}

pub fn recipient_identity(address: &Address) -> Option<RecipientIdentity> {
    let (recipient_type, bytes) = match address.to_payload()? {
        AddressPayload::AccountIdPublicKeyEd25519(bytes) => (0, bytes),
        AddressPayload::ContractIdHash(bytes) => (1, bytes),
    };
    let raw = bytes.to_array();
    let hi = u128_from_be_16(&raw[0..16]);
    let lo = u128_from_be_16(&raw[16..32]);
    Some(RecipientIdentity {
        recipient_type,
        bytes,
        hi,
        lo,
    })
}

fn u128_from_be_16(bytes: &[u8]) -> u128 {
    let mut out = [0u8; 16];
    out.copy_from_slice(bytes);
    u128::from_be_bytes(out)
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Address, Env};
    use std::{fmt::Write, string::String};

    const ACCOUNT_STRKEY: &str = "GAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX";
    const ACCOUNT_BYTES: [u8; 32] = [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d,
        0x1e, 0x1f,
    ];
    const ACCOUNT_HI: u128 = 5233100606242806050955395731361295;
    const ACCOUNT_LO: u128 = 21356283574076891493948969979685445151;

    const CONTRACT_STRKEY: &str = "CD7757P47P5PT6HX6327J47S6HYO73XN5TV6V2PI47TOLZHD4LQ6BAYK";
    const CONTRACT_BYTES: [u8; 32] = [
        0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8, 0xf7, 0xf6, 0xf5, 0xf4, 0xf3, 0xf2, 0xf1,
        0xf0, 0xef, 0xee, 0xed, 0xec, 0xeb, 0xea, 0xe9, 0xe8, 0xe7, 0xe6, 0xe5, 0xe4, 0xe3, 0xe2,
        0xe1, 0xe0,
    ];
    const CONTRACT_HI: u128 = 340277133820332220657323652036036850160;
    const CONTRACT_LO: u128 = 318926083346861571969425637452082766304;

    fn hex(bytes: &[u8; 32]) -> String {
        let mut s = String::new();
        for b in bytes {
            write!(&mut s, "{b:02x}").unwrap();
        }
        s
    }

    fn assert_identity(
        label: &str,
        strkey: &str,
        expected_type: u32,
        expected_bytes: [u8; 32],
        expected_hi: u128,
        expected_lo: u128,
    ) {
        let env = Env::default();
        let address = Address::from_str(&env, strkey);
        let identity = recipient_identity(&address).unwrap();
        assert_eq!(identity.recipient_type, expected_type);
        assert_eq!(identity.bytes.to_array(), expected_bytes);
        assert_eq!(identity.hi, expected_hi);
        assert_eq!(identity.lo, expected_lo);
        std::println!(
            "Phase A Rust {label}: type={} bytes={} hi={} lo={}",
            identity.recipient_type,
            hex(&identity.bytes.to_array()),
            identity.hi,
            identity.lo
        );
    }

    #[test]
    fn extracts_account_type_bytes_and_be_limbs() {
        assert_identity(
            "account",
            ACCOUNT_STRKEY,
            0,
            ACCOUNT_BYTES,
            ACCOUNT_HI,
            ACCOUNT_LO,
        );
    }

    #[test]
    fn extracts_contract_type_bytes_and_be_limbs() {
        assert_identity(
            "contract",
            CONTRACT_STRKEY,
            1,
            CONTRACT_BYTES,
            CONTRACT_HI,
            CONTRACT_LO,
        );
    }
}
