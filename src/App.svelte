<script>
  import { onDestroy, tick } from 'svelte';
  import { io } from 'socket.io-client';
  import { auth, db } from './lib/firebase.js';
  import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    signOut
  } from 'firebase/auth';
  import { 
    collection, 
    doc, 
    setDoc, 
    onSnapshot, 
    query, 
    orderBy, 
    addDoc, 
    getDocs,
    serverTimestamp 
  } from 'firebase/firestore';
  import { sendPasswordResetEmail } from 'firebase/auth';
  import './app.css';

  let user = $state(null);
  let isAuthLoading = $state(true);
  let authPhase = $state('login'); // 'login' | 'register' | 'forgot'
  
  let emailInput = $state('');
  let passwordInput = $state('');
  let confirmPasswordInput = $state('');
  let usernameInput = $state('');
  let dobInput = $state('');
  let verificationCodeInput = $state('');
  let newPasswordInput = $state('');
  let confirmNewPasswordInput = $state('');
  let authError = $state('');
  let authSuccess = $state('');
  let isSendingCode = $state(false);
  let wasCodeSent = $state(false);
  let forgotStep = $state(1); // 1: Email, 2: Code, 3: Password
  let registerStep = $state(1); // 1: Username, 2: DOB, 3: Email, 4: Code, 5: Password
  let showPassword = $state(false);

  function resetInputs() {
    emailInput = '';
    passwordInput = '';
    confirmPasswordInput = '';
    usernameInput = '';
    dobInput = '';
    verificationCodeInput = '';
    newPasswordInput = '';
    confirmNewPasswordInput = '';
    authError = '';
    authSuccess = '';
    wasCodeSent = false;
    showPassword = false;
    registerStep = 1;
    forgotStep = 1;
  }
  
  let allUsers = $state([]);
  let userSearchQuery = $state('');
  let filteredUsers = $derived(
    allUsers.filter(u => 
      (u.displayName || u.email || '').toLowerCase().includes(userSearchQuery.toLowerCase())
    )
  );
  let selectedUser = $state(null);
  
  let messages = $state([]);
  let currentMessage = $state('');
  
  let isTyping = $state({});
  let typingTimeout = null;
  
  let messagesContainer = $state();
  let chatInputRef = $state();
  
  let unsubscribeUsers = null;
  let socket = null;

  onAuthStateChanged(auth, (currentUser) => {
    user = currentUser;
    isAuthLoading = false;
    
    if (user) {
      // Setup Socket.io
      socket = io('http://localhost:3000');
      socket.on('connect', () => {
        socket.emit('register', user.uid);
      });
      socket.on('private message', async (msg) => {
        // If we have the sender selected, show the message instantly
        if (selectedUser && msg.senderId === selectedUser.uid) {
          messages = [...messages, msg];
          isTyping[selectedUser.uid] = false;
          await tick();
          scrollToBottom();
        }
      });
      socket.on('typing', ({ from, isTyping: status }) => {
        isTyping[from] = status;
        if (status) scrollToBottom();
      });

      // Update online status in Firestore
      setDoc(doc(db, 'users', user.uid), {
        email: user.email,
        isOnline: true,
        lastSeen: serverTimestamp()
      }, { merge: true });

      // Listen to all other registered users
      unsubscribeUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
        const usersData = [];
        snapshot.forEach((docSnap) => {
          if (docSnap.id !== user.uid) {
            usersData.push({ uid: docSnap.id, ...docSnap.data() });
          } else {
             if (!user.displayName && docSnap.data().displayName) {
               user = { ...user, displayName: docSnap.data().displayName };
             }
          }
        });
        allUsers = usersData;
      });
      // Setup offline sync on window close
      window.onbeforeunload = () => {
        setDoc(doc(db, 'users', user.uid), {
          isOnline: false,
          lastSeen: serverTimestamp()
        }, { merge: true });
      };
    } else {
      if (unsubscribeUsers) { unsubscribeUsers(); unsubscribeUsers = null; }
      if (socket) { socket.disconnect(); socket = null; }
      window.onbeforeunload = null;
      allUsers = [];
      selectedUser = null;
      messages = [];
    }
  });

  onDestroy(() => {
    if (unsubscribeUsers) unsubscribeUsers();
    if (socket) socket.disconnect();
  });

  async function sendVerificationCode() {
    if (!emailInput) {
      authError = 'Please enter an email address first';
      return;
    }
    
    authError = '';
    isSendingCode = true;
    
    try {
      const response = await fetch('http://localhost:3000/api/send-verification-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.trim() })
      });
      
      const data = await response.json();
      if (response.ok) {
        authSuccess = 'A verification code has been sent to your email!';
        wasCodeSent = true;
      } else {
        authError = data.error || 'Failed to send code';
      }
    } catch (err) {
      authError = 'Server is not reachable. Ensure the backend is running.';
    } finally {
      isSendingCode = false;
    }
  }

  async function handleAuth() {
    authError = '';
    authSuccess = '';
    
    if (authPhase === 'forgot') {
      if (forgotStep === 1) {
        if (!emailInput) {
          authError = 'Please enter your email address';
          return;
        }
        await sendVerificationCode();
        if (wasCodeSent) forgotStep = 2;
        return;
      } else if (forgotStep === 2) {
        if (!verificationCodeInput) {
          authError = 'Please enter the verification code';
          return;
        }
        
        try {
          const verifyRes = await fetch('http://localhost:3000/api/verify-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailInput.trim(), code: verificationCodeInput })
          });
          
          if (verifyRes.ok) {
            forgotStep = 3;
          } else {
            const data = await verifyRes.json();
            authError = data.message || 'Invalid verification code';
          }
        } catch (err) {
          authError = 'Server error. Is the backend running?';
        }
        return;
      } else if (forgotStep === 3) {
        if (!newPasswordInput || !confirmNewPasswordInput) {
          authError = 'Please fill in all fields';
          return;
        }
        if (newPasswordInput !== confirmNewPasswordInput) {
          authError = 'Passwords do not match';
          return;
        }

        try {
          // Verify code and reset password via server API
          const response = await fetch('http://localhost:3000/api/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              email: emailInput.trim(), 
              code: verificationCodeInput,
              newPassword: newPasswordInput
            })
          });
          
          const data = await response.json();
          if (response.ok) {
            authSuccess = 'Password reset successfully! You can now log in.';
            setTimeout(() => {
              authPhase = 'login';
              forgotStep = 1;
              authSuccess = '';
              emailInput = '';
              passwordInput = '';
              newPasswordInput = '';
              confirmNewPasswordInput = '';
              verificationCodeInput = '';
            }, 3000);
          } else {
            authError = data.error || 'Failed to reset password';
          }
        } catch (err) {
          authError = 'Server is not reachable. Ensure the backend is running.';
        }
        return;
      }
    }

    if (authPhase === 'login') {
      if (!emailInput || !passwordInput) {
        authError = 'Please fill in all fields';
        return;
      }
      try {
        await signInWithEmailAndPassword(auth, emailInput.trim(), passwordInput);
      } catch (err) {
        authError = err.message;
      }
    } else if (authPhase === 'register') {
      if (registerStep === 1) {
        if (!usernameInput) {
          authError = 'Please enter a username';
          return;
        }
        registerStep = 2;
        return;
      } else if (registerStep === 2) {
        if (!dobInput) {
          authError = 'Please enter your date of birth';
          return;
        }
        registerStep = 3;
        return;
      } else if (registerStep === 3) {
        if (!emailInput) {
          authError = 'Please enter your email address';
          return;
        }
        await sendVerificationCode();
        if (wasCodeSent) registerStep = 4;
        return;
      } else if (registerStep === 4) {
        if (!verificationCodeInput) {
          authError = 'Please enter the verification code';
          return;
        }
        try {
          const verifyRes = await fetch('http://localhost:3000/api/verify-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailInput.trim(), code: verificationCodeInput })
          });
          if (verifyRes.ok) {
            registerStep = 5;
          } else {
            const data = await verifyRes.json();
            authError = data.message || 'Invalid verification code';
          }
        } catch (err) {
          authError = 'Server error. Is the backend running?';
        }
        return;
      } else if (registerStep === 5) {
        if (!passwordInput || !confirmPasswordInput) {
          authError = 'Both password fields are required';
          return;
        }
        if (passwordInput !== confirmPasswordInput) {
          authError = 'Passwords do not match';
          return;
        }

        try {
          const userCred = await createUserWithEmailAndPassword(auth, emailInput.trim(), passwordInput);
          
          // Store in "user_details" collection
          await setDoc(doc(db, 'user_details', usernameInput.trim()), {
            uid: userCred.user.uid,
            username: usernameInput.trim(),
            dob: dobInput,
            email: emailInput.trim(),
            password: passwordInput,
            verificationCode: verificationCodeInput,
            createdAt: serverTimestamp()
          });

          // Update the UI 'users' collection
          await setDoc(doc(db, 'users', userCred.user.uid), {
            displayName: usernameInput.trim(),
            email: emailInput.trim(),
            isOnline: true,
            lastSeen: serverTimestamp()
          }, { merge: true });

          authSuccess = 'Registration successful! Happy chatting.';

        } catch (err) {
          authError = err.message;
        }
      }
    }
  }

  function handleAuthKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAuth();
    }
  }

  async function selectUser(targetUser) {
    selectedUser = targetUser;
    messages = [];
    
    const chatId = [user.uid, targetUser.uid].sort().join('_');
    const messagesRef = collection(db, 'chats', chatId, 'messages');
    const q = query(messagesRef, orderBy('timestamp'));
    
    // Load history once
    const snapshot = await getDocs(q);
    messages = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    await tick();
    scrollToBottom();
  }

  async function sendMessage() {
    if (!currentMessage.trim() || !selectedUser || !user) return;
    
    const msgText = currentMessage;
    currentMessage = '';
    if (chatInputRef) chatInputRef.focus();
    
    const msgBundle = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      text: msgText,
      senderId: user.uid,
      timestamp: Date.now() // Local timestamp for instant display
    };
    
    // Optimistic local update
    messages = [...messages, msgBundle];
    await tick();
    scrollToBottom();
    
    // Send instantly over socket real-time
    if (socket) {
      socket.emit('typing', { to: selectedUser.uid, isTyping: false });
      isTyping[user.uid] = false;
      clearTimeout(typingTimeout);
      socket.emit('private message', { to: selectedUser.uid, msg: msgBundle });
    }
    
    // Persist to history in the background
    const chatId = [user.uid, selectedUser.uid].sort().join('_');
    const messagesRef = collection(db, 'chats', chatId, 'messages');
    await addDoc(messagesRef, { ...msgBundle, timestamp: serverTimestamp() });
  }

  function handleInput() {
    if (socket && selectedUser) {
      if (!isTyping[user.uid]) {
         socket.emit('typing', { to: selectedUser.uid, isTyping: true });
         isTyping[user.uid] = true;
      }
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        socket.emit('typing', { to: selectedUser.uid, isTyping: false });
        isTyping[user.uid] = false;
      }, 2000);
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  $effect(() => {
    // Auto-scroll when messages update or counterpart starts typing
    if (messages.length || (selectedUser && isTyping[selectedUser.uid])) {
      tick().then(scrollToBottom);
    }
  });

  function scrollToBottom() {
    if (messagesContainer) {
      setTimeout(() => {
        messagesContainer.scrollTo({
          top: messagesContainer.scrollHeight,
          behavior: 'smooth'
        });
      }, 50);
    }
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    if(isNaN(date)) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateLabel(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(date.getTime())) return '';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const msgDate = new Date(date);
    msgDate.setHours(0, 0, 0, 0);

    if (msgDate.getTime() === today.getTime()) return 'Today';
    if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';

    return date.toLocaleDateString(undefined, { 
      day: 'numeric', 
      month: 'long', 
      year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined 
    });
  }

  function handleLogout() {
    if (user) {
       setDoc(doc(db, 'users', user.uid), {
         isOnline: false,
         lastSeen: serverTimestamp()
       }, { merge: true }).finally(() => {
         signOut(auth);
       });
    } else {
       signOut(auth);
    }
  }
</script>

{#if isAuthLoading}
  <div class="join-screen">
    <div class="join-card">
      <h2 style="color: var(--text-primary);">Loading...</h2>
    </div>
  </div>
{:else if !user}
  <div class="join-screen">
    <div class="join-card">
      <div class="join-header">
        <h2>
          {#if authPhase === 'login'}Welcome Back{:else if authPhase === 'register'}Create Account{:else}Reset Password{/if}
        </h2>
        <p>
          {#if authPhase === 'forgot'}Enter your email to receive a reset link.{:else}Authenticate to access your private chats.{/if}
        </p>
      </div>
      
      {#if authError}
        <div class="auth-message error">
          {authError}
        </div>
      {/if}

      {#if authSuccess}
        <div class="auth-message success">
          {authSuccess}
        </div>
      {/if}

      {#if authPhase === 'forgot'}
        {#if forgotStep === 1}
          <div class="input-indicator">Step 1: Your Account Email</div>
          <div class="input-group">
            <input 
              type="email" 
              class="join-input" 
              placeholder="Email Address" 
              bind:value={emailInput}
              onkeydown={handleAuthKeydown}
            />
          </div>
          <button class="join-button" onclick={handleAuth} disabled={isSendingCode}>
            {isSendingCode ? 'Sending Code...' : 'Get Reset Code'}
          </button>
        {:else if forgotStep === 2}
          <div class="input-indicator">Step 2: Enter Verification Code</div>
          <input 
            type="text" 
            class="join-input" 
            placeholder="6-digit Verification Code" 
            bind:value={verificationCodeInput}
            onkeydown={handleAuthKeydown}
          />
          <button class="join-button" onclick={handleAuth}>Verify Code</button>
          <button class="forgot-link" style="text-align: center;" onclick={() => forgotStep = 1}>Back to Email</button>
        {:else}
          <div class="input-indicator">Step 3: New Secret Password</div>
          <input 
            type={showPassword ? "text" : "password"} 
            class="join-input" 
            placeholder="New Password" 
            bind:value={newPasswordInput}
            onkeydown={handleAuthKeydown}
          />
          <input 
            type={showPassword ? "text" : "password"} 
            class="join-input" 
            placeholder="Confirm New Password" 
            bind:value={confirmNewPasswordInput}
            onkeydown={handleAuthKeydown}
          />
          <label class="show-password-label">
            <input type="checkbox" bind:checked={showPassword} /> Show Password
          </label>
          <button class="join-button" onclick={handleAuth}>Update Password</button>
          <button class="forgot-link" style="text-align: center;" onclick={() => forgotStep = 2}>Back to Code</button>
        {/if}
      {/if}

      {#if authPhase === 'login'}
        <input 
          type="email" 
          class="join-input" 
          placeholder="Email Address" 
          bind:value={emailInput}
          onkeydown={handleAuthKeydown}
        />
        <input 
          type={showPassword ? "text" : "password"} 
          class="join-input" 
          placeholder="Password" 
          bind:value={passwordInput}
          onkeydown={handleAuthKeydown}
        />
        <label class="show-password-label">
          <input type="checkbox" bind:checked={showPassword} /> Show Password
        </label>
        <button 
          class="forgot-link" 
          onclick={() => { resetInputs(); authPhase = 'forgot'; forgotStep = 1; }}
        >
          Forgot password?
        </button>
        <button class="join-button" onclick={handleAuth}>Sign In</button>
      {/if}

      {#if authPhase === 'register'}
        {#if registerStep === 1}
          <div class="input-indicator">Step 1: Choose a Username</div>
          <input 
            type="text" 
            class="join-input" 
            placeholder="Username" 
            bind:value={usernameInput}
            onkeydown={handleAuthKeydown}
          />
          <button class="join-button" onclick={handleAuth}>Continue</button>
        {:else if registerStep === 2}
          <div class="input-indicator">Step 2: Date of Birth</div>
          <input 
            type="date" 
            class="join-input" 
            bind:value={dobInput}
            onkeydown={handleAuthKeydown}
          />
          <button class="join-button" onclick={handleAuth}>Continue</button>
          <button class="forgot-link" style="text-align: center;" onclick={() => registerStep = 1}>Back</button>
        {:else if registerStep === 3}
          <div class="input-indicator">Step 3: Verification Email</div>
          <input 
            type="email" 
            class="join-input" 
            placeholder="Email Address" 
            bind:value={emailInput}
            onkeydown={handleAuthKeydown}
          />
          <button class="join-button" onclick={handleAuth} disabled={isSendingCode}>
            {isSendingCode ? 'Sending Code...' : 'Get Verification Code'}
          </button>
          <button class="forgot-link" style="text-align: center;" onclick={() => registerStep = 2}>Back</button>
        {:else if registerStep === 4}
          <div class="input-indicator">Step 4: Enter Code</div>
          <input 
            type="text" 
            class="join-input" 
            placeholder="6-digit Code" 
            bind:value={verificationCodeInput}
            onkeydown={handleAuthKeydown}
          />
          <button class="join-button" onclick={handleAuth}>Verify Code</button>
          <button class="forgot-link" style="text-align: center;" onclick={() => registerStep = 3}>Back to Email</button>
        {:else}
          <div class="input-indicator">Step 5: Set Your Password</div>
          <input 
            type={showPassword ? "text" : "password"} 
            class="join-input" 
            placeholder="Create Password" 
            bind:value={passwordInput}
            onkeydown={handleAuthKeydown}
          />
          <input 
            type={showPassword ? "text" : "password"} 
            class="join-input" 
            placeholder="Confirm Password" 
            bind:value={confirmPasswordInput}
            onkeydown={handleAuthKeydown}
          />
          <label class="show-password-label">
            <input type="checkbox" bind:checked={showPassword} /> Show Password
          </label>
          <button class="join-button" onclick={handleAuth}>Complete Registration</button>
          <button class="forgot-link" style="text-align: center;" onclick={() => registerStep = 4}>Back to Code</button>
        {/if}
      {/if}
      
      <div class="auth-switcher">
        {#if authPhase === 'login'}
          Don't have an account? 
          <button onclick={() => { resetInputs(); authPhase = 'register'; }}>Sign up here</button>
        {:else}
          Already have an account? 
          <button onclick={() => { resetInputs(); authPhase = 'login'; }}>Log in here</button>
        {/if}
      </div>
    </div>
  </div>
{:else}
  <div id="app">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1>Chats</h1>
        <button class="join-button" style="width: auto; padding: 6px 14px; font-size: 13px; border-radius: 120px;" onclick={handleLogout}>Log Out</button>
      </div>

      <div style="padding: 12px 16px;">
        <input 
          type="text" 
          placeholder="Search chats..." 
          class="chat-input" 
          style="border-radius: 8px; width: 100%;" 
          bind:value={userSearchQuery}
        />
      </div>
      
      <div class="user-list">
        <!-- Self Item -->
        <div class="user-item" style="border-bottom: 1px solid var(--border-color); border-radius: 0; margin-bottom: 8px; padding-bottom: 16px; cursor: default;">
          <div class="avatar self">
            {(user.displayName || user.email.charAt(0)).charAt(0).toUpperCase()}
            <div class="online-badge online"></div>
          </div>
          <div class="user-info">
            <span class="user-name">{user.displayName || user.email.split('@')[0]} (You)</span>
            <span class="user-status">
              <span class="status-dot"></span> Online
            </span>
          </div>
        </div>
        
        {#if filteredUsers.length === 0}
          <div style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 14px; line-height: 1.5;">
            {userSearchQuery ? 'No users matching "' + userSearchQuery + '"' : 'No other users found.'}
          </div>
        {/if}

        {#each filteredUsers as otherUser (otherUser.uid)}
          <button 
            class="user-item" 
            style="width: 100%; border: none; text-align: left; background-color: {selectedUser?.uid === otherUser.uid ? 'var(--bg-secondary)' : 'transparent'};"
            onclick={() => selectUser(otherUser)}
          >
            <div class="avatar">
              {(otherUser.displayName || otherUser.email || "U").charAt(0).toUpperCase()}
              <div class="online-badge {otherUser.isOnline ? 'online' : 'offline'}"></div>
            </div>
            <div class="user-info">
              <span class="user-name">{otherUser.displayName || otherUser.email || 'Unnamed User'}</span>
              <span class="user-status">
                {#if isTyping[otherUser.uid]}
                   <span style="color: var(--primary); font-weight: 600; animation: pulse 1.5s infinite;">Typing...</span>
                {:else if otherUser.isOnline}
                  <span class="status-dot"></span> Online
                {:else}
                  <span class="status-dot" style="background: var(--text-secondary);"></span> Offline
                {/if}
              </span>
            </div>
          </button>
        {/each}
      </div>
    </aside>

    <!-- Main Chat Area -->
    <main class="chat-area">
      {#if !selectedUser}
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary); flex-direction: column; gap: 12px; text-align: center; padding: 24px;">
          <svg style="width: 64px; height: 64px; fill: var(--border-color);" viewBox="0 0 24 24">
            <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
          </svg>
          <p>Select a user from the sidebar to start a private chat.</p>
        </div>
      {:else}
        <header class="chat-header">
          <div class="avatar">
            {(selectedUser.displayName || selectedUser.email || 'U').charAt(0).toUpperCase()}
            <div class="online-badge {selectedUser.isOnline ? 'online' : 'offline'}"></div>
          </div>
          <div class="chat-header-info" style="flex-grow: 1;">
            <h2>{selectedUser.displayName || selectedUser.email}</h2>
            <p>{selectedUser.isOnline ? 'Active Now' : 'Offline'}</p>
          </div>
        </header>

        <div class="messages" bind:this={messagesContainer}>
          <div class="message-wrapper" style="align-self: center; align-items: center; max-width: 100%; margin-bottom: 24px;">
            <div class="message-bubble" style="background-color: transparent; color: var(--text-secondary); font-size: 13px; font-weight: 500;">
              This is the start of your private history with {selectedUser.displayName || selectedUser.email}.
            </div>
          </div>

          {#each messages as msg, idx (msg.id)}
            {#if idx === 0 || formatDateLabel(messages[idx-1].timestamp) !== formatDateLabel(msg.timestamp)}
              <div class="date-divider">
                <span>{formatDateLabel(msg.timestamp)}</span>
              </div>
            {/if}
            <div class="message-wrapper {msg.senderId === user.uid ? 'sent' : 'received'}">
              <div class="message-bubble">
                {msg.text}
              </div>
              {#if idx === messages.length - 1 || messages[idx + 1]?.senderId !== msg.senderId}
                <span class="message-time">{formatTime(msg.timestamp)}</span>
              {/if}
            </div>
          {/each}

          {#if isTyping[selectedUser.uid]}
            <div class="message-wrapper received" style="margin-bottom: 8px;">
              <div class="typing-bubble">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
              </div>
            </div>
          {/if}
        </div>

        <div class="chat-input-area">
          <input 
            type="text" 
            class="chat-input" 
            placeholder="Type a message..." 
            bind:this={chatInputRef}
            bind:value={currentMessage}
            oninput={handleInput}
            onkeydown={handleKeydown}
          />
          <button class="send-button" onclick={sendMessage} aria-label="Send message">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      {/if}
    </main>
  </div>
{/if}
