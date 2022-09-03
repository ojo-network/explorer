import {
  AminoTypes,
  SignerData,
  SigningStargateClient,
  AminoConverters,
  createAuthzAminoConverters,
  createBankAminoConverters,
  createDistributionAminoConverters,
  createFreegrantAminoConverters,
  createGovAminoConverters,
  createIbcAminoConverters,
  createStakingAminoConverters,
} from '@cosmjs/stargate'
import {
  EncodeObject, TxBodyEncodeObject, makeAuthInfoBytes,
} from '@cosmjs/proto-signing'
import { LedgerSigner } from '@cosmjs/ledger-amino'
import TransportWebUSB from '@ledgerhq/hw-transport-webusb'
import TransportWebBLE from '@ledgerhq/hw-transport-web-ble'
import {
  StdFee,
} from '@cosmjs/amino'
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx'
import {
  generateMessageWithMultipleTransactions,
  generateTypes,
  generateFee,
  createEIP712,
} from '@tharsis/eip712'
import {
  createTxRawEIP712, signatureToWeb3Extension, Chain,
} from '@tharsis/transactions'
import {
  createTransactionWithMultipleMessages,
} from '@tharsis/proto'
import {
  fromBase64, fromBech32, fromHex, toBase64,
} from '@cosmjs/encoding'
// import { generateEndpointBroadcast, generatePostBodyBroadcast } from '@tharsis/provider'
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing'
import * as eth from '@tharsis/proto/dist/proto/ethermint/crypto/v1/ethsecp256k1/keys' // /ethermint/crypto/v1/ethsecp256k1/keys'
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys'
import { Int53 } from '@cosmjs/math'
import { Any } from 'cosmjs-types/google/protobuf/any'
import EthereumLedgerSigner from './EthereumLedgerSigner'
import { defaultMessageAdapter } from './MessageAdapter'

export interface TypedDataField {
    name: string;
    type: string;
}

function createDefaultTypes(prefix: string): AminoConverters {
  return {
    ...createAuthzAminoConverters(),
    ...createBankAminoConverters(),
    ...createDistributionAminoConverters(),
    ...createGovAminoConverters(),
    ...createStakingAminoConverters(prefix),
    ...createIbcAminoConverters(),
    ...createFreegrantAminoConverters(),
    // ...createVestingAminoConverters(),
  }
}

function extractChainId(chainId: string) {
  const start = chainId.indexOf('_')
  const end = chainId.indexOf('-')
  if (end > start && start > 0) {
    return Number(chainId.substring(start + 1, end))
  }
  return 0
}

function makeRawTxEvmos(sender, messages, memo, fee, signature, chain): Uint8Array {
  /// evmos style
  /// *
  const protoMsgs = messages.map(x => {
    const adapter = defaultMessageAdapter[x.typeUrl]
    return adapter.toProto(x)
  })

  const evmos = createTransactionWithMultipleMessages(
    protoMsgs,
    memo,
    fee.amount[0].amount,
    fee.amount[0].denom,
    Number(fee.gas),
    'ethsecp256',
    sender.pubkey,
    sender.sequence,
    sender.accountNumber,
    chain.cosmosChainId,
  )

  const extension = signatureToWeb3Extension(chain, sender, signature)

  // Create the txRaw
  const prototx = createTxRawEIP712(evmos.legacyAmino.body, evmos.legacyAmino.authInfo, extension)
  return prototx.message.serializeBinary()
  /// end of EVMOS style */
}

export class SigningEthermintClient {
  readonly signer: EthereumLedgerSigner

  aminoTypes: AminoTypes

  constructor(signer: EthereumLedgerSigner) {
    this.signer = signer
    this.aminoTypes = new AminoTypes(createDefaultTypes(''))
  }

  async sign(signerAddress: string, messages: readonly EncodeObject[], fee: StdFee, memo: string, explicitSignerData?: SignerData): Promise<Uint8Array> {
    const chain: Chain = {
      chainId: extractChainId(explicitSignerData.chainId),
      cosmosChainId: explicitSignerData.chainId,
    }

    this.signer.prefix = fromBech32(signerAddress).prefix
    const account = await this.signer.getAccounts()

    const acc = account.find(x => x.address === signerAddress)
    if (!acc) {
      throw new Error('The signer address dose not exsits in Ledger!')
    }
    const sender = {
      accountAddress: signerAddress,
      sequence: explicitSignerData.sequence,
      accountNumber: explicitSignerData.accountNumber,
      pubkey: toBase64(account[0].pubkey),
    }

    const fees = generateFee(fee.amount[0].amount, fee.amount[0].denom, fee.gas, signerAddress)

    const msgs = messages.map(x => this.aminoTypes.toAmino(x))
    const tx = generateMessageWithMultipleTransactions(
      sender.accountNumber.toString(),
      sender.sequence.toString(),
      explicitSignerData.chainId,
      memo,
      fees,
      msgs,
    )

    const types = generateTypes(defaultMessageAdapter[messages[0].typeUrl].getTypes())
    const eip = createEIP712(types, chain.chainId, tx)
    const sig = await this.signer.sign712(eip)

    const rawTx = makeRawTxEvmos(sender, messages, memo, fee, sig, chain)

    return Promise.resolve(rawTx)
  }
}
export function encodePubkey(pubkey: string): Any {
//   const value = new eth.ethermint.crypto.v1.ethsecp256k1.PubKey({ key: fromBase64(pubkey) })
//   return Any.fromPartial({
//     typeUrl: '/ethermint.crypto.v1.ethsecp256k1.PubKey',
//     value: value.serializeBinary(),
//   })
  return Any.fromPartial({
    typeUrl: '/ethermint.crypto.v1.ethsecp256k1.PubKey',
    value: PubKey.encode({
      key: fromBase64(pubkey),
    }).finish(),
  })
}

function makeRawTx(sender, messages, memo, fee, signature, registry): TxRaw {
  const pubkey = encodePubkey(sender.pubkey)

  const signedTxBody = {
    messages,
    memo,
  }
  const signedTxBodyEncodeObject: TxBodyEncodeObject = {
    typeUrl: '/cosmos.tx.v1beta1.TxBody',
    value: signedTxBody,
  }
  const signedTxBodyBytes = registry.encode(signedTxBodyEncodeObject)
  const signedGasLimit = Int53.fromString(fee.gas).toNumber()
  // const signedSequence = sender.sequence
  const signedAuthInfoBytes = makeAuthInfoBytes(
    [{ pubkey, sequence: sender.sequence }],
    fee.amount,
    signedGasLimit,
    SignMode.SIGN_MODE_LEGACY_AMINO_JSON,
  )
  const rawTx = TxRaw.fromPartial({
    bodyBytes: signedTxBodyBytes,
    authInfoBytes: signedAuthInfoBytes,
    signatures: [fromHex(signature)],
  })

  return rawTx
}

// export function createAnyMessage(messages: readonly EncodeObject[]) {
//     return messages.map(x => x.)
// }

export declare type SigningClient = SigningStargateClient | SigningEthermintClient;

export async function getSigningClient(device, hdpath): Promise<SigningClient> {
  let ledgerAppName = 'Cosmos'
  const coinType = Number(hdpath[1])
  switch (coinType) {
    case 60:
      return new SigningEthermintClient(await EthereumLedgerSigner.create(device, hdpath)) // 'Ethereum'
    case 529:
      ledgerAppName = 'Secret' // 'Secret'
      break
    case 852:
      ledgerAppName = 'Desmos' // 'Desmos'
      break
    case 118:
    default:
  }
  const transport = await (device === 'ledgerBle' ? TransportWebBLE.create() : TransportWebUSB.create())
  const signer = new LedgerSigner(transport, { hdPaths: [hdpath], ledgerAppName })
  return SigningStargateClient.offline(signer)
}
