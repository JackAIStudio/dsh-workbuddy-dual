import { WorkBuddyDualCredentialStore } from '../lib/index.js'
import { WorkBuddyDualCatalog } from '../lib/index.js'
import { WorkBuddyUpstreamClient } from '../lib/index.js'
import { createWorkBuddyDualShim } from '../lib/index.js'

async function main() {
  console.log('=== [DSH WorkBuddy Dual - Live Verification] ===\n')

  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyDualCredentialStore({
    refreshCN: cred => client.refreshToken(cred),
    refreshGlobal: cred => client.refreshToken(cred),
  })

  // 1. Verify Dual Credential Status
  console.log('1. Checking Dual Credential Discovery...')
  const cnStatus = await store.cn.status()
  const globalStatus = await store.global.status()
  console.log('   🇨🇳 CN Status:    ', cnStatus.state, cnStatus.state === 'signed-in' ? `(${cnStatus.nickname})` : '')
  console.log('   🌍 Global Status:', globalStatus.state, globalStatus.state === 'signed-in' ? `(${globalStatus.nickname})` : '')

  if (cnStatus.state !== 'signed-in' || globalStatus.state !== 'signed-in') {
    throw new Error('Verification failed: Both accounts must be signed-in on this machine.')
  }

  // 2. Verify Credit Balances
  console.log('\n2. Querying Live Credit Balances...')
  const cnCred = await store.cn.current()
  const globalCred = await store.global.current()

  const cnCredits = await client.fetchCredits(cnCred)
  const globalCredits = await client.fetchCredits(globalCred)
  console.log('   🇨🇳 CN Balance:    ', cnCredits.totalBalance, 'credits across', cnCredits.accounts.length, 'packages')
  console.log('   🌍 Global Balance:', globalCredits.totalBalance, 'credits across', globalCredits.accounts.length, 'packages')

  // 3. Verify Dynamic Model Catalog
  console.log('\n3. Querying Dynamic Models from Upstreams...')
  const catalog = new WorkBuddyDualCatalog()
  const cnModels = await client.fetchModels(cnCred)
  const globalModels = await client.fetchModels(globalCred)

  catalog.setModels('cn', cnModels)
  catalog.setModels('global', globalModels)

  console.log('   🇨🇳 CN Models Count:    ', cnModels.length, `(deepseek-v4.1-flash: ${cnModels.find(m => m.id === 'deepseek-v4.1-flash')?.billing?.credits})`)
  console.log('   🌍 Global Models Count:', globalModels.length, `(deepseek-v4.1-flash: ${globalModels.find(m => m.id === 'deepseek-v4.1-flash')?.billing?.credits})`)

  // 4. Test Shim Loopback Server
  console.log('\n4. Starting Loopback Shim Server...')
  const shim = createWorkBuddyDualShim({ store, client, catalog })
  await shim.ready
  console.log('   Shim listening on:', shim.origin)

  try {
    // 4.1 Test Models Endpoints
    const cnRes = await fetch(`${shim.origin}/cn/v1/models`)
    const cnJson = await cnRes.json()
    console.log('   GET /cn/v1/models:    ', cnRes.status, `(${cnJson.data?.length} models)`)

    const glRes = await fetch(`${shim.origin}/global/v1/models`)
    const glJson = await glRes.json()
    console.log('   GET /global/v1/models:', glRes.status, `(${glJson.data?.length} models)`)

    // 4.2 Test Live Streaming Completion on CN
    console.log('\n5. Testing Live Streaming Chat on CN (/cn/v1/chat/completions)...')
    const chatCNRes = await fetch(`${shim.origin}/cn/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-bearer',
      },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'Say "CN OK" in 2 words.' }],
        stream: true,
      }),
    })
    console.log('   CN HTTP Status:', chatCNRes.status)
    if (!chatCNRes.ok) throw new Error(`CN Chat failed: ${await chatCNRes.text()}`)
    const cnReader = chatCNRes.body.getReader()
    const cnChunk = await cnReader.read()
    console.log('   CN Stream First Chunk:', new TextDecoder().decode(cnChunk.value).slice(0, 150).replace(/\n/g, ' '))
    await cnReader.cancel()

    // 4.3 Test Live Streaming Completion on Global
    console.log('\n6. Testing Live Streaming Chat on Global (/global/v1/chat/completions)...')
    const chatGLRes = await fetch(`${shim.origin}/global/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-bearer',
      },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'Say "Global OK" in 2 words.' }],
        stream: true,
      }),
    })
    console.log('   Global HTTP Status:', chatGLRes.status)
    if (!chatGLRes.ok) throw new Error(`Global Chat failed: ${await chatGLRes.text()}`)
    const glReader = chatGLRes.body.getReader()
    const glChunk = await glReader.read()
    console.log('   Global Stream First Chunk:', new TextDecoder().decode(glChunk.value).slice(0, 150).replace(/\n/g, ' '))
    await glReader.cancel()

    console.log('\n✅ ALL VERIFICATION CHECKS PASSED!')
  } finally {
    await shim.close()
  }
}

main().catch(err => {
  console.error('\n❌ VERIFICATION ERROR:', err)
  process.exit(1)
})
