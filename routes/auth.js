const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const db = require('../db/index');

const router = express.Router();

// WebAuthn configuration
const rpName = 'Notes App';
const rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
const origin = process.env.WEBAUTHN_ORIGIN || (rpID === 'localhost' ? 'http://localhost:3003' : `https://${rpID}`);

// Helper to get current datetime
function getDateTime() {
  return new Date().toISOString();
}

// Check if setup is needed (no passkeys registered)
router.get('/setup-needed', async (req, res) => {
  const isPostgres = !!process.env.DATABASE_URL;
  let count;
  if (isPostgres) {
    const result = await db.get('SELECT COUNT(*) as count FROM passkey_credentials');
    count = parseInt(result?.count, 10) || 0;
  } else {
    const result = db.get('SELECT COUNT(*) as count FROM passkey_credentials');
    count = parseInt(result?.count, 10) || 0;
  }
  console.log('Setup needed check, count:', count, 'setupNeeded:', count === 0);
  res.json({ setupNeeded: count === 0 });
});

// Generate registration options (for initial setup)
router.get('/passkey/register-options', async (req, res) => {
  try {
    console.log('Generating registration options');
    console.log('RP Config:', { rpName, rpID, origin });

    const isPostgres = !!process.env.DATABASE_URL;
    let existingPasskeys;
    if (isPostgres) {
      existingPasskeys = await db.all('SELECT credential_id FROM passkey_credentials');
    } else {
      existingPasskeys = db.all('SELECT credential_id FROM passkey_credentials');
    }

    // Build excludeCredentials array
    const excludeCreds = existingPasskeys
      .filter(pk => pk.credential_id && typeof pk.credential_id === 'string')
      .map(pk => ({
        id: pk.credential_id,
        type: 'public-key',
      }));

    const options = await generateRegistrationOptions({
      rpName: String(rpName),
      rpID: String(rpID),
      userID: new Uint8Array(Buffer.from('1')), // Single user ID
      userName: 'notes-user',
      userDisplayName: 'Notes User',
      attestationType: 'none',
      excludeCredentials: excludeCreds,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store challenge in session
    req.session.passkeyRegChallenge = options.challenge;

    console.log('Generated registration options');
    res.json(options);
  } catch (err) {
    console.error('Passkey register options error:', err);
    res.status(500).json({ error: 'Failed to generate options: ' + err.message });
  }
});

// Complete registration
router.post('/passkey/register', async (req, res) => {
  try {
    const { response, deviceName } = req.body;
    const expectedChallenge = req.session.passkeyRegChallenge;

    console.log('Passkey registration attempt');

    if (!expectedChallenge) {
      return res.status(400).json({ error: 'No pending registration' });
    }

    if (!response) {
      return res.status(400).json({ error: 'No response provided' });
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }

    const { credential, credentialID, credentialPublicKey, counter } = verification.registrationInfo;

    // Handle both old and new SimpleWebAuthn API
    const pubKey = credential?.publicKey || credentialPublicKey;
    const credCounter = credential?.counter ?? counter ?? 0;

    // Use the rawId from client request
    const clientCredentialId = response.rawId || response.id;

    console.log('Storing credential');

    const isPostgres = !!process.env.DATABASE_URL;
    if (isPostgres) {
      await db.run(`
        INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, device_name, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [1, clientCredentialId, Buffer.from(pubKey).toString('base64url'), credCounter, deviceName || 'Unknown Device', getDateTime()]);
    } else {
      db.run(`
        INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, device_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, clientCredentialId, Buffer.from(pubKey).toString('base64url'), credCounter, deviceName || 'Unknown Device', getDateTime()]);
    }

    delete req.session.passkeyRegChallenge;

    // Auto-login after registration
    req.session.authenticated = true;

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Session save failed' });
      }
      console.log('Passkey registered successfully');
      res.json({ success: true });
    });
  } catch (err) {
    console.error('Passkey register error:', err);
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

// Generate authentication options (auto login - no username needed)
router.get('/passkey/login-options', async (req, res) => {
  try {
    console.log('Generating auth options, rpID:', rpID);

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      // No allowCredentials - discoverable credentials
    });

    req.session.passkeyChallenge = options.challenge;

    console.log('Generated auth options');
    res.json(options);
  } catch (err) {
    console.error('Passkey login options error:', err);
    res.status(500).json({ error: 'Failed to generate options: ' + err.message });
  }
});

// Verify authentication
router.post('/passkey/login', async (req, res) => {
  try {
    const { response } = req.body;
    const expectedChallenge = req.session.passkeyChallenge;

    console.log('Passkey login attempt');

    if (!expectedChallenge) {
      return res.status(400).json({ error: 'No pending authentication' });
    }

    const credentialId = response.rawId || response.id;
    console.log('Looking for credential:', credentialId?.substring(0, 30));

    const isPostgres = !!process.env.DATABASE_URL;
    let passkey;
    if (isPostgres) {
      passkey = await db.get('SELECT * FROM passkey_credentials WHERE credential_id = $1', [credentialId]);
    } else {
      passkey = db.get('SELECT * FROM passkey_credentials WHERE credential_id = ?', [credentialId]);
    }

    if (!passkey) {
      console.log('Passkey not found');
      return res.status(400).json({ error: 'Passkey not found' });
    }

    console.log('Found passkey');

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: new Uint8Array(Buffer.from(passkey.credential_id, 'base64url')),
        publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64url')),
        counter: passkey.counter,
      },
    });

    if (!verification.verified) {
      return res.status(400).json({ error: 'Verification failed' });
    }

    // Update counter
    if (isPostgres) {
      await db.run('UPDATE passkey_credentials SET counter = $1, last_used_at = $2 WHERE id = $3',
        [verification.authenticationInfo.newCounter, getDateTime(), passkey.id]);
    } else {
      db.run('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?',
        [verification.authenticationInfo.newCounter, getDateTime(), passkey.id]);
    }

    // Set authenticated
    req.session.authenticated = true;
    delete req.session.passkeyChallenge;

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Session save failed' });
      }
      console.log('Passkey login successful');
      res.json({ success: true, redirect: '/' });
    });
  } catch (err) {
    console.error('Passkey login error:', err);
    res.status(500).json({ error: 'Authentication failed: ' + err.message });
  }
});

// List passkeys (for settings page)
router.get('/passkey/list', async (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const isPostgres = !!process.env.DATABASE_URL;
  let passkeys;
  if (isPostgres) {
    passkeys = await db.all('SELECT id, device_name, created_at, last_used_at FROM passkey_credentials');
  } else {
    passkeys = db.all('SELECT id, device_name, created_at, last_used_at FROM passkey_credentials');
  }
  res.json(passkeys);
});

// Delete a passkey
router.post('/passkey/:id/delete', async (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const isPostgres = !!process.env.DATABASE_URL;
  if (isPostgres) {
    await db.run('DELETE FROM passkey_credentials WHERE id = $1', [req.params.id]);
  } else {
    db.run('DELETE FROM passkey_credentials WHERE id = ?', [req.params.id]);
  }
  res.json({ success: true });
});

// Reset all passkeys (temporary - remove after setup)
router.post('/reset-passkeys', async (req, res) => {
  const isPostgres = !!process.env.DATABASE_URL;
  if (isPostgres) {
    await db.run('DELETE FROM passkey_credentials');
  } else {
    db.run('DELETE FROM passkey_credentials');
  }
  req.session.destroy(() => {});
  res.json({ success: true, message: 'All passkeys deleted. Refresh to set up new one.' });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.json({ success: true });
  });
});

module.exports = router;
