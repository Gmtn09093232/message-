/* =====================================================
   SecureChat – Encrypted Messaging App
   ===================================================== */

// ========== CONFIG ==========
// Replace these with your own Supabase project values
const SUPABASE_URL = 'https://gtxbpxdehdsfdqkaamqf.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0eGJweGRlaGRzZmRxa2FhbXFmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzkxOTQyNiwiZXhwIjoyMTAzNDk1NDI2fQ.sMQQoYWqjs7qAYJ7W_953Xn9svSM4K2Q4R_d7ZLyHrY'

// ========== INIT ==========
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// State
let currentUser = null
let currentProfile = null
let selectedUser = null
let users = []
let messages = []
let realtimeChannel = null
let isSignup = false

// Crypto key cache (per conversation)
const conversationKeys = new Map()

// ========== DOM ELEMENTS ==========
const authScreen = document.getElementById('auth-screen')
const appEl = document.getElementById('app')
const authError = document.getElementById('auth-error')
const loginForm = document.getElementById('login-form')
const signupForm = document.getElementById('signup-form')
const authSwitchLink = document.getElementById('auth-switch-link')
const authSwitchText = document.getElementById('auth-switch-text')

// ========== AUTH ==========
authSwitchLink.addEventListener('click', () => {
  isSignup = !isSignup
  loginForm.style.display = isSignup ? 'none' : 'block'
  signupForm.style.display = isSignup ? 'block' : 'none'
  authSwitchText.textContent = isSignup ? 'Already have an account?' : "Don't have an account?"
  authSwitchLink.textContent = isSignup ? 'Sign in' : 'Sign up'
  authError.classList.remove('show')
})

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = document.getElementById('login-email').value.trim()
  const password = document.getElementById('login-password').value
  const btn = document.getElementById('login-btn')

  btn.disabled = true
  btn.innerHTML = '<div class="spinner"></div>'

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    showAuthError(error.message)
    btn.disabled = false
    btn.textContent = 'Sign In'
    return
  }

  await initApp(data.user)
})

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const username = document.getElementById('signup-username').value.trim()
  const fullName = document.getElementById('signup-fullname').value.trim()
  const email = document.getElementById('signup-email').value.trim()
  const phone = document.getElementById('signup-phone').value.trim()
  const password = document.getElementById('signup-password').value
  const btn = document.getElementById('signup-btn')

  btn.disabled = true
  btn.innerHTML = '<div class="spinner"></div>'

  // Generate key pair for E2EE
  const keyPair = await generateKeyPair()
  const publicKeyB64 = await exportPublicKey(keyPair.publicKey)
  // Store private key in localStorage (never sent to server)
  localStorage.setItem(`privateKey_${email}`, await exportPrivateKey(keyPair.privateKey))

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        username,
        full_name: fullName,
        phone: phone || null
      }
    }
  })

  if (error) {
    showAuthError(error.message)
    btn.disabled = false
    btn.textContent = 'Create Account'
    return
  }

  // Update profile with public key and phone
  if (data.user) {
    await supabase.from('profiles').update({
      public_key: publicKeyB64,
      phone: phone || null,
      full_name: fullName
    }).eq('id', data.user.id)

    // If email confirmation is disabled, go straight in
    if (data.session) {
      await initApp(data.user)
    } else {
      showAuthError('Check your email to confirm your account, then sign in.')
      btn.disabled = false
      btn.textContent = 'Create Account'
      isSignup = false
      loginForm.style.display = 'block'
      signupForm.style.display = 'none'
      authSwitchText.textContent = "Don't have an account?"
      authSwitchLink.textContent = 'Sign up'
    }
  }
})

function showAuthError(msg) {
  authError.textContent = msg
  authError.classList.add('show')
}

// ========== APP INIT ==========
async function initApp(user) {
  currentUser = user

  // Load or create profile
  let { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) {
    // Fallback create
    const username = user.user_metadata?.username || user.email.split('@')[0]
    await supabase.from('profiles').insert({
      id: user.id,
      username,
      full_name: user.user_metadata?.full_name || '',
      phone: user.user_metadata?.phone || null
    })
    ;({ data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single())
  }

  // Ensure we have a key pair
  if (!profile.public_key) {
    const keyPair = await generateKeyPair()
    const publicKeyB64 = await exportPublicKey(keyPair.publicKey)
    localStorage.setItem(`privateKey_${user.email}`, await exportPrivateKey(keyPair.privateKey))
    await supabase.from('profiles').update({ public_key: publicKeyB64 }).eq('id', user.id)
    profile.public_key = publicKeyB64
  }

  currentProfile = profile

  // UI
  authScreen.style.display = 'none'
  appEl.classList.add('active')
  updateMyChip()
  await loadUsers()
  setupRealtime()
}

function updateMyChip() {
  const chip = document.getElementById('current-user-chip')
  const avatarEl = document.getElementById('my-avatar')
  const nameEl = document.getElementById('my-username')

  nameEl.textContent = currentProfile.username

  if (currentProfile.avatar_url) {
    avatarEl.outerHTML = `<img src="${currentProfile.avatar_url}" id="my-avatar" alt="Me" />`
  } else {
    avatarEl.textContent = (currentProfile.username || '?')[0].toUpperCase()
  }
}

// ========== USERS ==========
async function loadUsers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .neq('id', currentUser.id)
    .order('username')

  if (error) {
    console.error(error)
    return
  }

  users = data || []
  renderUsers(users)
}

function renderUsers(list) {
  const container = document.getElementById('users-list')
  container.innerHTML = ''

  if (list.length === 0) {
    container.innerHTML = `<p style="padding:20px;color:var(--text-muted);font-size:14px;text-align:center">No other users yet</p>`
    return
  }

  list.forEach(user => {
    const el = document.createElement('div')
    el.className = 'user-item' + (selectedUser?.id === user.id ? ' active' : '')
    el.dataset.id = user.id

    const avatar = user.avatar_url
      ? `<img src="${user.avatar_url}" alt="${user.username}" />`
      : `<div class="avatar-placeholder">${(user.username || '?')[0].toUpperCase()}</div>`

    el.innerHTML = `
      ${avatar}
      <div class="info">
        <div class="name">${user.full_name || user.username}</div>
        <div class="username">@${user.username}</div>
      </div>
    `

    el.addEventListener('click', () => selectUser(user))
    container.appendChild(el)
  })
}

document.getElementById('user-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim()
  const filtered = users.filter(u =>
    (u.username || '').toLowerCase().includes(q) ||
    (u.full_name || '').toLowerCase().includes(q)
  )
  renderUsers(filtered)
})

// ========== SELECT USER / LOAD CHAT ==========
async function selectUser(user) {
  selectedUser = user

  // Update UI
  document.querySelectorAll('.user-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === user.id)
  })

  document.getElementById('chat-empty').style.display = 'none'
  const chatActive = document.getElementById('chat-active')
  chatActive.style.display = 'flex'

  // Header
  const avatarEl = document.getElementById('receiver-avatar')
  if (user.avatar_url) {
    avatarEl.outerHTML = `<img src="${user.avatar_url}" id="receiver-avatar" alt="${user.username}" />`
  } else {
    avatarEl.textContent = (user.username || '?')[0].toUpperCase()
    avatarEl.className = 'avatar-placeholder'
  }
  document.getElementById('receiver-name').textContent = user.full_name || user.username
  document.getElementById('receiver-username').textContent = `@${user.username}`

  await loadMessages()
}

async function loadMessages() {
  if (!selectedUser) return

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${selectedUser.id}),and(sender_id.eq.${selectedUser.id},receiver_id.eq.${currentUser.id})`)
    .order('created_at', { ascending: true })

  if (error) {
    console.error(error)
    return
  }

  messages = data || []
  await renderMessages()
}

async function renderMessages() {
  const container = document.getElementById('messages-container')
  container.innerHTML = ''

  for (const msg of messages) {
    const isSent = msg.sender_id === currentUser.id
    let plaintext = '[Unable to decrypt]'

    try {
      plaintext = await decryptMessage(msg)
    } catch (err) {
      console.warn('Decrypt failed for message', msg.id, err)
    }

    const el = document.createElement('div')
    el.className = `message ${isSent ? 'sent' : 'received'}`
    el.innerHTML = `
      <div>${escapeHtml(plaintext)}</div>
      <div class="time">${formatTime(msg.created_at)}</div>
    `
    container.appendChild(el)
  }

  container.scrollTop = container.scrollHeight
}

// ========== SEND MESSAGE ==========
document.getElementById('send-btn').addEventListener('click', sendMessage)
document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})

async function sendMessage() {
  const input = document.getElementById('message-input')
  const text = input.value.trim()
  if (!text || !selectedUser) return

  const btn = document.getElementById('send-btn')
  btn.disabled = true

  try {
    // Encrypt for the receiver
    const { ciphertext, iv } = await encryptMessage(text, selectedUser)

    const { data, error } = await supabase
      .from('messages')
      .insert({
        sender_id: currentUser.id,
        receiver_id: selectedUser.id,
        ciphertext,
        iv
      })
      .select()
      .single()

    if (error) throw error

    // Optimistically add to UI
    messages.push(data)
    await renderMessages()
    input.value = ''

    // SMS is handled by the database webhook / Edge Function on insert
  } catch (err) {
    console.error(err)
    alert('Failed to send message: ' + err.message)
  } finally {
    btn.disabled = false
  }
}

// ========== ENCRYPTION (Web Crypto API – ECDH + AES-GCM) ==========
async function generateKeyPair() {
  return await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )
}

async function exportPublicKey(key) {
  const exported = await window.crypto.subtle.exportKey('raw', key)
  return btoa(String.fromCharCode(...new Uint8Array(exported)))
}

async function exportPrivateKey(key) {
  const exported = await window.crypto.subtle.exportKey('pkcs8', key)
  return btoa(String.fromCharCode(...new Uint8Array(exported)))
}

async function importPublicKey(b64) {
  const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return await window.crypto.subtle.importKey(
    'raw',
    binary,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  )
}

async function importPrivateKey(b64) {
  const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return await window.crypto.subtle.importKey(
    'pkcs8',
    binary,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )
}

async function getConversationKey(otherUser) {
  const cacheKey = [currentUser.id, otherUser.id].sort().join(':')
  if (conversationKeys.has(cacheKey)) {
    return conversationKeys.get(cacheKey)
  }

  // Get my private key
  const privB64 = localStorage.getItem(`privateKey_${currentUser.email}`)
  if (!privB64) throw new Error('Private key not found. Please re-login or re-register.')

  const myPrivateKey = await importPrivateKey(privB64)
  const theirPublicKey = await importPublicKey(otherUser.public_key)

  // Derive shared secret → AES key
  const sharedKey = await window.crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: theirPublicKey
    },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )

  conversationKeys.set(cacheKey, sharedKey)
  return sharedKey
}

async function encryptMessage(plaintext, receiver) {
  const key = await getConversationKey(receiver)
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  )

  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...iv))
  }
}

async function decryptMessage(msg) {
  // Determine the other party
  const otherId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id
  let otherUser = users.find(u => u.id === otherId)

  if (!otherUser) {
    // Might be ourselves in edge cases, or fetch
    const { data } = await supabase.from('profiles').select('*').eq('id', otherId).single()
    otherUser = data
  }

  if (!otherUser?.public_key) throw new Error('No public key')

  const key = await getConversationKey(otherUser)
  const iv = Uint8Array.from(atob(msg.iv), c => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(msg.ciphertext), c => c.charCodeAt(0))

  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  )

  return new TextDecoder().decode(decrypted)
}

// ========== REALTIME ==========
function setupRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel)
  }

  realtimeChannel = supabase
    .channel('messages')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages'
      },
      async (payload) => {
        const msg = payload.new
        // Only care about messages involving me
        if (msg.sender_id !== currentUser.id && msg.receiver_id !== currentUser.id) return

        // If currently chatting with this person, add to view
        if (selectedUser &&
            ((msg.sender_id === selectedUser.id && msg.receiver_id === currentUser.id) ||
             (msg.sender_id === currentUser.id && msg.receiver_id === selectedUser.id))) {
          // Avoid duplicates
          if (!messages.find(m => m.id === msg.id)) {
            messages.push(msg)
            await renderMessages()
          }
        }
      }
    )
    .subscribe()
}

// ========== PROFILE MODAL ==========
const profileModal = document.getElementById('profile-modal')

document.getElementById('current-user-chip').addEventListener('click', () => {
  document.getElementById('profile-username').value = currentProfile.username || ''
  document.getElementById('profile-fullname').value = currentProfile.full_name || ''
  document.getElementById('profile-phone').value = currentProfile.phone || ''

  const preview = document.getElementById('profile-avatar-preview')
  const placeholder = document.getElementById('profile-avatar-placeholder')

  if (currentProfile.avatar_url) {
    preview.src = currentProfile.avatar_url
    preview.style.display = 'block'
    placeholder.style.display = 'none'
  } else {
    preview.style.display = 'none'
    placeholder.style.display = 'flex'
    placeholder.textContent = (currentProfile.username || '?')[0].toUpperCase()
  }

  profileModal.classList.add('active')
})

document.getElementById('profile-cancel').addEventListener('click', () => {
  profileModal.classList.remove('active')
})

document.getElementById('avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  if (!file) return

  const fileExt = file.name.split('.').pop()
  const filePath = `${currentUser.id}/avatar.${fileExt}`

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(filePath, file, { upsert: true })

  if (uploadError) {
    alert('Upload failed: ' + uploadError.message)
    return
  }

  const { data: { publicUrl } } = supabase.storage
    .from('avatars')
    .getPublicUrl(filePath)

  // Add cache buster
  const url = publicUrl + '?t=' + Date.now()

  await supabase.from('profiles').update({ avatar_url: url }).eq('id', currentUser.id)
  currentProfile.avatar_url = url

  document.getElementById('profile-avatar-preview').src = url
  document.getElementById('profile-avatar-preview').style.display = 'block'
  document.getElementById('profile-avatar-placeholder').style.display = 'none'

  updateMyChip()
})

document.getElementById('profile-save').addEventListener('click', async () => {
  const username = document.getElementById('profile-username').value.trim()
  const fullName = document.getElementById('profile-fullname').value.trim()
  const phone = document.getElementById('profile-phone').value.trim()

  const { error } = await supabase.from('profiles').update({
    username,
    full_name: fullName,
    phone: phone || null
  }).eq('id', currentUser.id)

  if (error) {
    alert('Save failed: ' + error.message)
    return
  }

  currentProfile.username = username
  currentProfile.full_name = fullName
  currentProfile.phone = phone

  updateMyChip()
  profileModal.classList.remove('active')
  await loadUsers() // refresh list in case names changed
})

document.getElementById('logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut()
  location.reload()
})

// ========== HELPERS ==========
function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function formatTime(iso) {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ========== SESSION CHECK ==========
supabase.auth.getSession().then(({ data: { session } }) => {
  if (session?.user) {
    initApp(session.user)
  }
})

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    location.reload()
  }
})
