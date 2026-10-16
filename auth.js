// --- Autenticação (Firebase Auth: e-mail e senha) ---
import {
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    updateProfile,
    signOut
} from "https://www.gstatic.com/firebasejs/11.9.0/firebase-auth.js";

const ERROR_MESSAGES = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/missing-password': 'Digite a senha.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/user-not-found': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/email-already-in-use': 'Já existe uma conta com esse e-mail. Tente entrar.',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente de novo.',
    'auth/network-request-failed': 'Sem conexão com a internet. Tente novamente.',
    'auth/operation-not-allowed': 'O login por e-mail/senha não está ativado. No Firebase Console, vá em Authentication > Sign-in method e ative "E-mail/senha".',
    'auth/unauthorized-domain': 'Este domínio não está autorizado. No Firebase Console, vá em Authentication > Settings > Authorized domains e adicione o domínio do seu site.',
    'auth/invalid-api-key': 'API key inválida. Confira o firebase-config.js.',
    'auth/api-key-not-valid': 'API key inválida. Confira o firebase-config.js.',
    'auth/configuration-not-found': 'Authentication ainda não foi iniciado no projeto. No Firebase Console, abra Authentication e clique em "Vamos começar".'
};

const $ = (id) => document.getElementById(id);

function showMessage(text, type = 'error') {
    const box = $('auth-message');
    box.textContent = text;
    box.className = `auth-alert auth-alert-${type} mt-4`;
}

function clearMessage() {
    $('auth-message').className = 'hidden';
}

function friendlyError(err) {
    console.error(err);
    return ERROR_MESSAGES[err.code] || 'Algo deu errado. Tente novamente.';
}

function switchTab(tab) {
    const isLogin = tab === 'login';
    $('login-form').classList.toggle('hidden', !isLogin);
    $('signup-form').classList.toggle('hidden', isLogin);
    $('tab-login').classList.toggle('active', isLogin);
    $('tab-signup').classList.toggle('active', !isLogin);
    clearMessage();
}

// Desabilita o botão enquanto a requisição roda (evita cliques duplos)
async function withLoading(form, fn) {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
}

function showApp(user) {
    $('auth-screen').classList.add('hidden');
    $('main-app').classList.remove('hidden');
    $('user-label').textContent = user.displayName || user.email;
}

function showAuthScreen() {
    $('main-app').classList.add('hidden');
    $('auth-screen').classList.remove('hidden');
    $('login-form').reset();
    $('signup-form').reset();
    switchTab('login');
}

/**
 * Liga a tela de login/cadastro ao Firebase Auth.
 * onLogin(user)  -> chamado quando alguém entra (use user.uid como id dos dados)
 * onLogout()     -> chamado quando ninguém está logado
 */
export function initAuth(app, { onLogin, onLogout }) {
    const auth = getAuth(app);

    // Aviso se o firebase-config.js ainda está com os valores de exemplo
    const apiKey = app.options.apiKey || '';
    if (apiKey.startsWith('COLE_AQUI')) {
        const warn = $('config-warning');
        warn.textContent = 'Configure o arquivo firebase-config.js com os dados do seu projeto Firebase (veja o README).';
        warn.classList.remove('hidden');
    }

    $('tab-login').onclick = () => switchTab('login');
    $('tab-signup').onclick = () => switchTab('signup');

    $('login-form').onsubmit = (e) => {
        e.preventDefault();
        clearMessage();
        return withLoading(e.target, async () => {
            try {
                await signInWithEmailAndPassword(auth, $('login-email').value.trim(), $('login-password').value);
            } catch (err) {
                showMessage(friendlyError(err));
            }
        });
    };

    $('signup-form').onsubmit = (e) => {
        e.preventDefault();
        clearMessage();
        const name = $('signup-name').value.trim();
        const email = $('signup-email').value.trim();
        const password = $('signup-password').value;
        if (password !== $('signup-password-confirm').value) {
            showMessage('As senhas não conferem.');
            return;
        }
        return withLoading(e.target, async () => {
            try {
                const cred = await createUserWithEmailAndPassword(auth, email, password);
                if (name) {
                    await updateProfile(cred.user, { displayName: name });
                    $('user-label').textContent = name;
                }
            } catch (err) {
                showMessage(friendlyError(err));
            }
        });
    };

    $('forgot-password-btn').onclick = async () => {
        clearMessage();
        const email = $('login-email').value.trim();
        if (!email) {
            showMessage('Digite seu e-mail no campo acima e clique em "Esqueci minha senha" de novo.');
            return;
        }
        try {
            await sendPasswordResetEmail(auth, email);
        } catch (err) {
            // Não revela se o e-mail existe ou não, exceto em erros de formato/rede/configuração
            if (['auth/invalid-email', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/operation-not-allowed'].includes(err.code)) {
                showMessage(friendlyError(err));
                return;
            }
            console.error(err);
        }
        showMessage('Se esse e-mail tiver uma conta, enviamos um link para redefinir a senha. Confira também o spam.', 'success');
    };

    $('logout-btn').onclick = () => signOut(auth);

    onAuthStateChanged(auth, (user) => {
        if (user) {
            showApp(user);
            onLogin(user);
        } else {
            showAuthScreen();
            onLogout();
        }
    });

    return auth;
}
