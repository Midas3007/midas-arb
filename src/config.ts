import 'dotenv/config'

// A token's short name inside one chain's token table (e.g. 'USDT' for the cash token, 'cNGN', 'EURC').
export type TokenKey = string

// Data folder: state.json, ledger.jsonl and one sub-folder per chain.
export const DATA_DIR = process.env.DATA_DIR ?? 'data'

// Celo only: the Loops House attribution tag of Kiyoshi's original builder, appended to Celo transactions.
// Set ATTRIBUTION_TAG= (empty) to turn it off.
export const ATTRIBUTION_TAG = process.env.ATTRIBUTION_TAG ?? 'celo_f6214d29d540'
