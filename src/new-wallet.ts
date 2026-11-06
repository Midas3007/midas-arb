import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const pk = generatePrivateKey()
console.log('Peg Hunter address :', privateKeyToAccount(pk).address, '(the same address on every chain)')
console.log('Private key        :', pk)
console.log('\nPut the key in .env as HUNTER_PRIVATE_KEY. Never commit it, never share it.')
console.log('Use this wallet only for Peg Hunter: not for Kiyoshi, not for the fund.')
