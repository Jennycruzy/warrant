# WARRANT Demo Narration

## Opening

WARRANT is provable, private delegated spending on Stellar. A principal funds a custody
contract and commits private delegation terms as a hash: per-payment limit, exposure cap,
maximum permitted decline, and approved recipients. The chain never sees those terms or
the account state. It sees the commitment, the state root, the public payment details,
and a proof.

## Recorded Sequence

1. Show the split view: private account controls on the left, public Stellar state on the
   right. The private limits and holdings stay local; Stellar stores only commitments
   and roots.

2. Choose an approved recipient and a compliant payment amount. Generate the witness,
   prove in the browser, approve the wallet transaction, and open the explorer link after
   the payment lands. The recipient balance increases and the state root advances.

3. Push the amount above the private per-payment limit. The witness fails before any
   transaction exists. Label this as "never reached chain."

4. Select the non-approved recipient. The approved-recipient proof cannot be built, so
   nothing is submitted to Stellar.

5. Submit a forged proof. This does reach Stellar, and the contract rejects it on-chain.
   Open the reverted transaction in the explorer.

6. Replay the last valid proof. The contract rejects it because the state root already
   advanced. Open the reverted transaction in the explorer.

7. Use the redirect and type-confusion checks on the address-bound deployment. A proof
   for one recipient cannot pay a different address, and a proof for one address type
   cannot pay the other type.

8. Lower the authenticated valuation. The same payment that was previously valid can no
   longer be proven because the permitted-decline rule is breached. Again, no transaction
   is submitted.

9. Open observer view. The public bytes show commitment, root, proof bytes, public inputs,
   recipient identity, and oracle signature. The private spending terms, holdings, and
   approved-recipient list are absent.

## Closing

The primitive is not limited to one workflow. Autonomous agents are the frontier version:
an agent may propose payments, but the custody contract releases funds only when the proof
binds the private delegation terms, approved-recipient identity, authenticated valuation,
and current state.
