// --- Imports ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.0/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, doc, deleteDoc, writeBatch, updateDoc, getDocs, where } from "https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';
import { initAuth } from './auth.js';

const ACCENT = '#d80816'; 

function applyChartTheme(theme) {
    const dark = theme === 'dark';
    Chart.defaults.color = dark ? '#94a3b8' : '#6b7280';
    Chart.defaults.borderColor = dark ? 'rgba(148, 163, 184, 0.15)' : 'rgba(0, 0, 0, 0.08)';
    Chart.defaults.elements.arc.borderColor = dark ? '#1e293b' : '#ffffff';
}

function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('tema', theme); } catch (e) {}
    document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    applyChartTheme(theme);
    updateAllCharts(); // redesenha os gráficos com as cores do novo tema
}

let app, db;
let userId = null; // uid do usuário logado (definido em initAuth)
let transactions = [];
let recurringExpenses = [];
let accounts = [];
let chartInstances = {};
let isUIReady = false;
let unsubscribeListeners = [];

const categoryOptions = {
    expense: 
    `<optgroup label="Despesas Comuns">
    <option value="Alimentação">Alimentação</option>
    <option value="Moradia">Moradia</option>
    <option value="Transporte">Transporte</option>
    <option value="Saúde">Saúde</option>
    <option value="Lazer">Lazer</option>
    <option value="Educação">Educação</option>
    <option value="Compras">Compras</option>
    <option value="Assinatura">Assinatura</option>
    <option value="Igreja">Igreja</option>
    </optgroup>
    <optgroup label="Investimentos"><option value="Investimento (Aporte)">Investimento (Aporte)</option>
    </optgroup>
    <optgroup label="Geral"><option value="Outros">Outros</option>
    </optgroup>`,

    income:
     `<optgroup label="Receitas">
     <option value="Salário">Salário</option>
     <option value="Crédito VR">Crédito VR</option>
     <option value="Rendimentos">Rendimentos</option>
     <option value="Resgate Guardado">Resgate (Dinheiro Guardado)</option>
     <option value="Vendas">Vendas / Serviços</option>
     <option value="Fatura do Cartão">Fatura do Cartão</option>
     </optgroup>
     <optgroup label="Geral">
     <option value="Outros">Outros</option>
     </optgroup>`
};


const PAYMENT_METHODS = {
    pix_debito: 'Pix/Débito',
    credito: 'Crédito',
    vr: 'VR'
};

function getPaymentMethod(transaction) {
    // Compatibilidade com dados antigos
    if (transaction.paymentMethod) {
        return transaction.paymentMethod;
    }

    // Transações antigas que usavam o checkbox
    if (transaction.paidWithVR) {
        return 'vr';
    }

    return 'pix_debito';
}

function getPaymentMethodLabel(transaction) {
    return PAYMENT_METHODS[getPaymentMethod(transaction)] || 'Pix/Débito';
}

function fitBigNumbers() {
    document.querySelectorAll('.big-number').forEach(el => {
        let size = 30;                       // tamanho máximo (text-3xl)
        el.style.fontSize = size + 'px';
        while (el.scrollWidth > el.clientWidth && size > 12) {
            size -= 1;
            el.style.fontSize = size + 'px';
        }
    });
}

// --- Helpers ---
const openModal = (modalId) => document.getElementById(modalId)?.classList.remove('hidden');
const closeModal = () => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
const formatCurrency = (value) => (value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function showConfirmation(message, onConfirm) {
    document.getElementById('confirm-modal-message').textContent = message;
    const confirmBtn = document.getElementById('confirm-modal-confirm');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    
    const confirmHandler = () => { onConfirm(); closeModal(); cleanup(); };
    const cancelHandler = () => { closeModal(); cleanup(); };

    function cleanup() {
        confirmBtn.removeEventListener('click', confirmHandler);
        cancelBtn.removeEventListener('click', cancelHandler);
    }

    confirmBtn.addEventListener('click', confirmHandler);
    cancelBtn.addEventListener('click', cancelHandler);
    openModal('confirm-modal');
}

// --- Funções de Inicialização e Autenticação ---
function initializeFinanceApp() {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);

    setupEventListeners();
    setTheme(document.documentElement.dataset.theme || 'dark');
    document.getElementById('theme-toggle').addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    // Os dados só são carregados depois do login, usando o uid como "dono" dos dados
    initAuth(app, {
        onLogin: (user) => {
            if (user.uid === userId) return;
            userId = user.uid;
            setupRealtimeListeners();
        },
        onLogout: resetSession
    });
}

// Limpa tudo que pertence ao usuário que saiu (listeners, dados em memória, gráficos e filtros)
function resetSession() {
    unsubscribeListeners.forEach(unsub => unsub());
    unsubscribeListeners = [];
    userId = null;
    transactions = [];
    recurringExpenses = [];
    accounts = [];
    Object.values(chartInstances).forEach(chart => chart?.destroy());
    chartInstances = {};
    isUIReady = false;
    ['filter-date-from', 'filter-date-to', 'filter-category', 'filter-payment']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('content').classList.add('hidden');
    document.getElementById('data-error').classList.add('hidden');
    document.getElementById('loading-spinner').classList.remove('hidden');
    closeModal();
}

function handleDataError(err) {
    console.error('Erro ao carregar dados:', err);
    document.getElementById('loading-spinner').classList.add('hidden');
    const box = document.getElementById('data-error');
    box.textContent = `Não foi possível carregar seus dados (${err.code || 'erro'}). Confira se o Firestore foi criado e se as regras de segurança foram publicadas (veja o README).`;
    box.classList.remove('hidden');
}

function setupRealtimeListeners() {
    if (!userId) return;
    const getPath = (coll) => `users/${userId}/${coll}`;
    
    const unsubTransactions = onSnapshot(query(collection(db, getPath('transactions'))), () => { checkAndSyncData().catch(handleDataError); }, handleDataError);
    const unsubRecurring = onSnapshot(query(collection(db, getPath('recurringExpenses'))), () => { checkAndSyncData().catch(handleDataError); }, handleDataError);
    const unsubAccounts = onSnapshot(query(collection(db, getPath('accounts'))), () => { checkAndSyncData().catch(handleDataError); }, handleDataError);

    unsubscribeListeners.push(unsubTransactions, unsubRecurring, unsubAccounts);
}

async function checkAndSyncData() {
    if (!userId) return;
    const uid = userId;
    const getPath = (coll) => `users/${uid}/${coll}`;

    const [transactionsSnap, recurringSnap, accountsSnap] = await Promise.all([
        getDocs(query(collection(db, getPath('transactions')))),
        getDocs(query(collection(db, getPath('recurringExpenses')))),
        getDocs(query(collection(db, getPath('accounts'))))
    ]);

    if (uid !== userId) return; // o usuário saiu ou trocou de conta durante a consulta
    transactions = transactionsSnap.docs.map(d => ({id: d.id, ...d.data()}));
    recurringExpenses = recurringSnap.docs.map(d => ({id: d.id, ...d.data()}));
    accounts = accountsSnap.docs.map(d => ({id: d.id, ...d.data()}));
    
    const batch = writeBatch(db);
    const today = new Date(); today.setHours(0,0,0,0);
    const existingRecTransactions = new Set(transactions.filter(t => t.recurringExpenseId).map(t => `${t.recurringExpenseId}_${t.date}`));
    let hasChanges = false;
    
    recurringExpenses.forEach(rec => {
        let currentDate = new Date(rec.startDate + 'T00:00:00Z');
        while (currentDate <= today) {
            const dateString = currentDate.toISOString().split('T')[0];
            const uniqueId = `${rec.id}_${dateString}`;
            if (!existingRecTransactions.has(uniqueId)) {
                hasChanges = true;
                batch.set(doc(collection(db, getPath('transactions'))), {
                    description: `${rec.description} (Recorrente)`,
                    amount: rec.amount,
                    type: 'expense',
                    category: rec.category,
                    date: dateString,
                    recurringExpenseId: rec.id,
                    paymentMethod: rec.paymentMethod || 'pix_debito'
});
            }
            currentDate.setUTCMonth(currentDate.getUTCMonth() + (rec.frequency === 'monthly' ? 1 : 12));
        }
    });
    
    if (hasChanges) {
        await batch.commit().catch(e => console.error("Error syncing:", e));
    } else {
        updateUI();
    }
}

// --- Funções de UI e Renderização ---
function updateUI() {
    const contentDiv = document.getElementById('content');
    if (!contentDiv || !userId) return;
    if (!isUIReady) {
        document.getElementById('loading-spinner').classList.add('hidden');
        contentDiv.classList.remove('hidden');
        isUIReady = true;
    }
    renderFilterCategorySelect();
    renderTransactionList();
    renderAccountsList();
    renderRecurringExpensesListModal();
    renderAccountDropdowns();
    renderBudgetCategorySelect();
    updateAllCharts();
}

function updateAllCharts() {
    if(!isUIReady) return;
    Object.values(chartInstances).forEach(chart => chart?.destroy());
    updateDashboardCards();
    updateExpensesByCategoryChart();
    updateMonthlyFlowChart();
    updateAnnualProjectionChart();
    updateInvestmentGrowthChart();
    updateCashFlowProjectionChart();
    updateBudgetBurnDownChart();
    updateExpensesByPaymentMethodChart();
}

function renderFilterCategorySelect() {
    const select = document.getElementById('filter-category');
    if (!select) return;
    const current = select.value;   // guarda a seleção, pois o UI é redesenhado a cada snapshot
    const categories = [...new Set(transactions.map(t => t.category))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    select.innerHTML = `<option value="">Todas</option>` +
        categories.map(c => `<option value="${c}">${c}</option>`).join('');
    select.value = categories.includes(current) ? current : '';
}

function getFilteredTransactions() {
    const from = document.getElementById('filter-date-from')?.value;
    const to = document.getElementById('filter-date-to')?.value;
    const category = document.getElementById('filter-category')?.value;
    const payment = document.getElementById('filter-payment')?.value;

    return transactions.filter(t => {
        if (from && t.date < from) return false;   // datas são 'AAAA-MM-DD', comparação de texto funciona
        if (to && t.date > to) return false;
        if (category && t.category !== category) return false;
        if (payment && (t.type !== 'expense' || getPaymentMethod(t) !== payment)) return false;
        return true;
    });
}

function renderTransactionList() {
    const listElement = document.getElementById('transaction-list');

    if (!listElement) return;

    const sortedTransactions = getFilteredTransactions().sort(
        (a, b) => new Date(b.date) - new Date(a.date)
    );

    if (sortedTransactions.length === 0) {
        listElement.innerHTML = `
            <tr>
                <td
                    colspan="6"
                    class="text-center py-10 text-gray-500"
                >
                    Nenhuma transação.
                </td>
            </tr>
        `;

        return;
    }

    listElement.innerHTML = sortedTransactions
        .map(t => {
            const paymentMethod = getPaymentMethod(t);
            const paymentLabel = getPaymentMethodLabel(t);

            let paymentClasses = '';

            if (paymentMethod === 'pix_debito') {
                paymentClasses =
                    'bg-white text-indigo-700 border border-indigo-200';
            } else if (paymentMethod === 'credito') {
                paymentClasses =
                    'bg-white text-blue-700 border border-blue-200';
            } else {
                paymentClasses =
                    'bg-white text-orange-700 border border-orange-200';
            }

            return `
                <tr
                    class="${
                        t.type === 'income'
                            ? 'bg-green-50'
                            : 'bg-red-50'
                    }"
                >

                    <!-- Descrição -->
                    <td class="px-6 py-4 whitespace-nowrap">
                        <div class="text-sm font-medium text-gray-900">
                            ${t.description}
                        </div>
                    </td>

                    <!-- Valor -->
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span
                            class="text-sm font-semibold ${
                                t.type === 'income'
                                    ? 'text-green-700'
                                    : 'text-red-700'
                            }"
                        >
                            ${t.type === 'income' ? '+' : '-'}
                            ${formatCurrency(t.amount)}
                        </span>
                    </td>

                    <!-- Categoria -->
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span
                            class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-200 text-gray-800"
                        >
                            ${t.category}
                        </span>
                    </td>

                    <!-- Data -->
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        ${new Date(
                            t.date + 'T00:00:00'
                        ).toLocaleDateString('pt-BR')}
                    </td>

                    <!-- Pagamento -->
                    <td class="px-6 py-4 whitespace-nowrap text-sm">
                        ${
                            t.type === 'expense'
                                ? `
                                    <span
                                        class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${paymentClasses}"
                                    >
                                        ${paymentLabel}
                                    </span>
                                `
                                : `
                                    <span class="text-gray-400">
                                        —
                                    </span>
                                `
                        }
                    </td>

                    <!-- Ações -->
                    <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button type="button" data-id="${t.id}"class="edit-transaction-btn text-teal-700 hover:text-teal-900 font-semibold mr-3">Editar</button>
                        <button
                            type="button"
                            data-id="${t.id}"
                            class="delete-transaction-btn text-red-600 hover:text-red-800 font-semibold"
                        >
                            Excluir
                        </button>

                    </td>

                </tr>
            `;
        })
        .join('');

    document.querySelectorAll('.delete-transaction-btn').forEach(btn => {btn.onclick = event => {const id = event.currentTarget.dataset.id;
                deleteTransaction(id);
            };
        });
    document.querySelectorAll('.edit-transaction-btn').forEach(btn => {
        btn.onclick = e => openEditTransaction(e.currentTarget.dataset.id);
    });
}

function renderRecurringExpensesListModal() {
    const listElement = document.getElementById('recurring-expenses-list-modal');
    listElement.innerHTML = '';
    if (recurringExpenses.length === 0) {
        listElement.innerHTML = `<p class="text-center text-gray-500">Nenhuma despesa recorrente cadastrada.</p>`;
        return;
    }
    listElement.innerHTML = recurringExpenses.map(rec => `
        <div class="flex justify-between items-center p-2 border-b">
            <div>
                <p class="font-semibold">${rec.description} (${rec.category})</p>
                <p class="text-sm text-gray-600">${formatCurrency(rec.amount)} / ${rec.frequency === 'monthly' ? 'mês' : 'ano'}</p>
            </div>
            <button data-id="${rec.id}" class="delete-recurring-btn text-red-500 hover:text-red-700 font-bold">X</button>
        </div>
    `).join('');
    document.querySelectorAll('.delete-recurring-btn').forEach(btn => btn.onclick = (e) => deleteRecurringExpense(e.target.dataset.id));
}

function renderAccountsList() {
     const listElement = document.getElementById('accounts-list');
    listElement.innerHTML = '';
    if (accounts.length === 0) {
        listElement.innerHTML = `<p class="text-center text-gray-500 py-4">Nenhuma conta encontrada.</p>`;
        return;
    }
    listElement.innerHTML = accounts.map(acc => {
        const hasGoal = acc.goalAmount && acc.goalAmount > 0;
        let progressHtml = '';
        if (hasGoal) {
            const percentage = Math.min((acc.currentValue / acc.goalAmount) * 100, 100);
            const monthlyContributions = transactions
                .filter(t => t.type === 'expense' && t.category === 'Investimento (Aporte)' && t.accountId === acc.id)
                .reduce((acc, t) => {
                    const month = new Date(t.date).toLocaleDateString('pt-BR', {month:'2-digit', year:'numeric'});
                    acc[month] = (acc[month] || 0) + t.amount;
                    return acc;
                }, {});
            
            const avgContribution = Object.values(monthlyContributions).reduce((a,b) => a+b, 0) / (Object.keys(monthlyContributions).length || 1);
            const remainingAmount = acc.goalAmount - acc.currentValue;
            let projectionText = '';
            if (avgContribution > 0 && remainingAmount > 0) {
                const monthsRemaining = Math.ceil(remainingAmount / avgContribution);
                const completionDate = new Date();
                completionDate.setMonth(completionDate.getMonth() + monthsRemaining);
                projectionText = ` <span class="text-xs text-gray-500"> - Meta: ${completionDate.toLocaleDateString('pt-BR', {month: 'long', year: 'numeric'})}</span>`;
            }

            progressHtml = `
                <div class="mt-2">
                    <div class="flex justify-between text-xs font-medium text-gray-600">
                        <span>Progresso</span>
                        <span>${formatCurrency(acc.currentValue)} / ${formatCurrency(acc.goalAmount)}</span>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-2.5 mt-1">
                        <div class="bg-teal-600 h-2.5 rounded-full" style="width: ${percentage}%"></div>
                    </div>
                    <p class="text-right">${projectionText}</p>
                </div>
            `;
        }

        return `
        <div class="p-4 border rounded-lg">
            <div class="flex flex-wrap items-center justify-between gap-4">
                <div><p class="font-semibold text-gray-800">${acc.name}</p><p class="text-2xl font-bold text-teal-700">${formatCurrency(acc.currentValue)}</p></div>
                <div class="flex flex-wrap gap-2">
                    <button data-id="${acc.id}" data-action="deposit" class="account-action-btn bg-green-100 text-green-800 text-xs font-bold py-1 px-3 rounded-full hover:bg-green-200">Aportar</button>
                    <button data-id="${acc.id}" data-action="withdraw" class="account-action-btn bg-blue-100 text-blue-800 text-xs font-bold py-1 px-3 rounded-full hover:bg-blue-200">Resgatar</button>
                    <button data-id="${acc.id}" data-action="update" class="account-action-btn bg-yellow-100 text-yellow-800 text-xs font-bold py-1 px-3 rounded-full hover:bg-yellow-200">Atualizar</button>
                    <button data-id="${acc.id}" class="delete-account-btn bg-red-100 text-red-800 text-xs font-bold py-1 px-3 rounded-full hover:bg-red-200">Excluir</button>
                </div>
            </div>
            ${progressHtml}
        </div>
    `}).join('');
    
    document.querySelectorAll('.account-action-btn').forEach(btn => btn.onclick = (e) => setupAccountActionModal(e.target.dataset.id, e.target.dataset.action));
    document.querySelectorAll('.delete-account-btn').forEach(btn => btn.onclick = (e) => deleteAccount(e.target.dataset.id));
}

function renderAccountDropdowns() {
    const selects = [document.getElementById('account-select'), document.getElementById('investment-account-select')];
    selects.forEach(select => {
        if (select) {
            select.innerHTML = accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
            if (accounts.length === 0) select.innerHTML = `<option value="" disabled>Crie uma conta primeiro</option>`;
        }
    });
}

function renderBudgetCategorySelect() {
    const select = document.getElementById('budget-category-select');
    if (!select) return;
    const expenseCategories = Object.keys(transactions.filter(t => t.type === 'expense').reduce((acc, t) => { acc[t.category] = true; return acc; }, {}));
    select.innerHTML = `<option value="">Selecione uma categoria</option>` + expenseCategories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
}

function updateCategoryDropdown() {
    const type = document.getElementById('type').value;
    document.getElementById('category').innerHTML = categoryOptions[type];
    togglePaymentOptions();
}

function togglePaymentOptions() {
    const type = document.getElementById('type').value;
    const category = document.getElementById('category').value;

    document.getElementById('account-selection-section')
        .classList.toggle('hidden', category !== 'Investimento (Aporte)');

    document.getElementById('payment-method-section')
        .classList.toggle('hidden', type !== 'expense');
}

function updateDashboardCards() {
    if (!isUIReady) return;

    // ================================
    // SALDO VR
    // ================================

    const vrCredits = transactions
        .filter(t => t.category === 'Crédito VR')
        .reduce((s, t) => s + t.amount, 0);

    const vrExpenses = transactions
        .filter(t => t.type === 'expense' && getPaymentMethod(t) === 'vr')
        .reduce((s, t) => s + t.amount, 0);

    document.getElementById('vr-balance').textContent =
        formatCurrency(vrCredits - vrExpenses);


    // ================================
    // SALDO PRINCIPAL
    // ================================


    const mainIncomes = transactions
        .filter(t =>
            t.type === 'income' &&
            t.category !== 'Crédito VR'
        )
        .reduce((s, t) => s + t.amount, 0);

    const mainExpenses = transactions
        .filter(t =>
            t.type === 'expense' &&
            getPaymentMethod(t) !== 'vr'
        )
        .reduce((s, t) => s + t.amount, 0);

    document.getElementById('balance').textContent =
        formatCurrency(mainIncomes - mainExpenses);


    // ================================
    // TOTAL GUARDADO
    // ================================

    document.getElementById('total-saved').textContent =
        formatCurrency(
            accounts.reduce((s, a) => s + a.currentValue, 0)
        );


    // ================================
    // MÊS ATUAL
    // ================================

    const now = new Date();
    const currentMonth = now.getUTCMonth();
    const currentYear = now.getUTCFullYear();


    const getMonthlyTotal = (type, excludeInternal) =>
        transactions
            .filter(t => {

                const transactionDate =
                    new Date(t.date + 'T00:00:00Z');

                let condition =
                    transactionDate.getUTCMonth() === currentMonth &&
                    transactionDate.getUTCFullYear() === currentYear &&
                    t.type === type;

                if (excludeInternal) {
                    condition =
                        condition &&
                        t.category !== 'Crédito VR' &&
                        getPaymentMethod(t) !== 'vr' &&
                        t.category !== 'Investimento (Aporte)' &&
                        t.category !== 'Resgate Guardado';
                }

                return condition;
            })
            .reduce((s, t) => s + t.amount, 0);


    // ================================
    // RECEITAS DO MÊS
    // ================================

    document.getElementById('income').textContent =
        formatCurrency(
            getMonthlyTotal('income', true)
        );


    // ================================
    // DESPESAS DO MÊS
    // ================================

    document.getElementById('expenses').textContent =
        formatCurrency(
            getMonthlyTotal('expense', true)
        );


    // ================================
    // CRÉDITO DO MÊS
    // ================================

    const creditExpenses = transactions
        .filter(t => {

            const transactionDate =
                new Date(t.date + 'T00:00:00Z');

            return (
                t.type === 'expense' &&
                getPaymentMethod(t) === 'credito' &&
                transactionDate.getUTCMonth() === currentMonth &&
                transactionDate.getUTCFullYear() === currentYear
            );
        })
        .reduce((s, t) => s + t.amount, 0);

    const creditElement =
        document.getElementById('credit-expenses');

    if (creditElement) {
        creditElement.textContent =
            formatCurrency(creditExpenses);
    }

    window.addEventListener('resize', fitBigNumbers);
    document.fonts?.ready.then(fitBigNumbers);   // recalcula quando a fonte Inter carregar 
}

function updateExpensesByCategoryChart() {
     if (!isUIReady) return;
    const ctx = document.getElementById('expensesByCategoryChart')?.getContext('2d');
    if (!ctx) return;

    const dataByCategory = transactions.filter(t => t.type === 'expense').reduce((acc, t) => {
        acc[t.category] = (acc[t.category] || 0) + t.amount;
        return acc;
    }, {});

    chartInstances.expensesByCategory = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(dataByCategory),
            datasets: [{ data: Object.values(dataByCategory), backgroundColor: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#0d9488'], hoverOffset: 4 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
}

function updateExpensesByPaymentMethodChart() {
    if (!isUIReady) return;

    const ctx = document
        .getElementById('expensesByPaymentMethodChart')
        ?.getContext('2d');

    if (!ctx) return;

    const paymentData = {
        'Pix/Débito': 0,
        'Crédito': 0,
        'VR': 0
    };

    transactions
        .filter(t => t.type === 'expense')
        .forEach(t => {
            const method = getPaymentMethod(t);

            if (method === 'pix_debito') {
                paymentData['Pix/Débito'] += t.amount;
            }

            if (method === 'credito') {
                paymentData['Crédito'] += t.amount;
            }

            if (method === 'vr') {
                paymentData['VR'] += t.amount;
            }
        });

    chartInstances.expensesByPaymentMethod = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(paymentData),
            datasets: [{
                data: Object.values(paymentData),
                backgroundColor: [
                    '#6366f1',
                    '#3b82f6',
                    '#f97316'
                ],
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom'
                }
            }
        }
    });
}

function updateMonthlyFlowChart() {
    if (!isUIReady) return;
    const ctx = document.getElementById('monthlyFlowChart')?.getContext('2d');
    if (!ctx) return;
    const labels = [];
    const incomeData = [];
    const expenseData = [];

    for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() - i);
        labels.push(d.toLocaleString('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' }));
        const month = d.getUTCMonth();
        const year = d.getUTCFullYear();

        const getFlow = (type) => transactions
            .filter(t => {
                const tDate = new Date(t.date + 'T00:00:00Z');
                return tDate.getUTCMonth() === month && tDate.getUTCFullYear() === year && t.type === type && t.category !== 'Crédito VR';
            })
            .reduce((sum, t) => sum + t.amount, 0);
        
        incomeData.push(getFlow('income'));
        expenseData.push(getFlow('expense'));
    }

    chartInstances.monthlyFlow = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Receitas', data: incomeData, backgroundColor: 'rgba(34, 197, 94, 0.6)' }, { label: 'Despesas', data: expenseData, backgroundColor: 'rgba(239, 68, 68, 0.6)' }] },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });
}
function updateAnnualProjectionChart() {
    if (!isUIReady) return;
    const ctx = document.getElementById('annualProjectionChart')?.getContext('2d');
    if (!ctx) return;

    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();

    const startOfYear = new Date(Date.UTC(currentYear, 0, 1));
    const priorTransactions = transactions.filter(t => new Date(t.date + 'T00:00:00Z') < startOfYear);
    let yearStartBalance = priorTransactions.reduce((bal, t) => {
        if (t.paidWithVR || t.category === 'Crédito VR') return bal;
        return bal + (t.type === 'income' ? t.amount : -t.amount);
    }, 0);

    const last3Months = new Date();
    last3Months.setUTCMonth(last3Months.getUTCMonth() - 3);
    const recentTransactions = transactions.filter(t => new Date(t.date + 'T00:00:00Z') >= last3Months);
    const avgNetFlow = (recentTransactions.filter(t => t.type === 'income' && t.category !== 'Crédito VR').reduce((s, t) => s + t.amount, 0) - recentTransactions.filter(t => t.type === 'expense' && !t.paidWithVR).reduce((s, t) => s + t.amount, 0)) / 3;

    const labels = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(Date.UTC(currentYear, i, 1));
        return d.toLocaleString('pt-BR', { month: 'short', timeZone: 'UTC' });
    });
    
    const balanceData = [];
    let lastActualBalance = yearStartBalance;

    for (let i = 0; i < 12; i++) {
        if (i <= currentMonth) {
            const monthTransactions = transactions.filter(t => {
                const tDate = new Date(t.date + 'T00:00:00Z');
                return tDate.getUTCFullYear() === currentYear && tDate.getUTCMonth() === i;
            });
            const monthNetFlow = monthTransactions.reduce((bal, t) => {
                if (t.paidWithVR || t.category === 'Crédito VR') return bal;
                return bal + (t.type === 'income' ? t.amount : -t.amount);
            }, 0);
            lastActualBalance += monthNetFlow;
            balanceData.push(lastActualBalance);
        } else {
            const projectedBalance = balanceData[balanceData.length - 1] + avgNetFlow;
            balanceData.push(projectedBalance);
        }
    }
    
    const actualData = balanceData.slice(0, currentMonth + 1);
    const projectedData = Array(currentMonth).fill(null).concat(balanceData.slice(currentMonth));

    chartInstances.annualProjection = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Saldo Real', data: actualData, borderColor: '#4f46e5', backgroundColor: 'rgba(79, 70, 229, 0.1)', fill: false, tension: 0.1 },
                { label: 'Saldo Projetado', data: projectedData, borderColor: '#4f46e5', borderDash: [5, 5], backgroundColor: 'rgba(79, 70, 229, 0.1)', fill: false, tension: 0.1 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, }
    });
}
function updateInvestmentGrowthChart() {
    if (!isUIReady) return;
    const ctx = document.getElementById('investmentGrowthChart')?.getContext('2d');
    if (!ctx) return;
    
    const accountId = document.getElementById('investment-account-select').value;
    const annualRate = parseFloat(document.getElementById('investment-rate').value) / 100 || 0;
    const selectedAccount = accounts.find(a => a.id === accountId);
    
    if (!selectedAccount) {
         if(chartInstances.investmentGrowth) chartInstances.investmentGrowth.destroy();
         return;
    }

    const principal = selectedAccount.currentValue;
    const labels = Array.from({length: 6}, (_, i) => new Date().getFullYear() + i);
    const data = labels.map((_, i) => (principal * Math.pow(1 + annualRate / 12, 12 * i)).toFixed(2));
    
    chartInstances.investmentGrowth = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Crescimento Projetado', data, backgroundColor: '#0d9488' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
}
function updateCashFlowProjectionChart() {
    if (!isUIReady) return;
    const ctx = document.getElementById('cashFlowProjectionChart')?.getContext('2d');
    if (!ctx) return;

    const labels = [];
    const projectedIncomeData = [];
    const projectedExpenseData = [];
    
    const incomeTransactions = transactions.filter(t => t.type === 'income' && t.category !== 'Crédito VR');
    const monthlyIncome = {};
    incomeTransactions.forEach(t => {
        const monthYear = new Date(t.date).toLocaleDateString('pt-BR', {month:'2-digit', year:'numeric'});
        monthlyIncome[monthYear] = (monthlyIncome[monthYear] || 0) + t.amount;
    });
    const lastMonthsIncomes = Object.values(monthlyIncome).slice(-3);
    const avgIncome = lastMonthsIncomes.reduce((a, b) => a + b, 0) / (lastMonthsIncomes.length || 1);
    
    const totalMonthlyRecurring = recurringExpenses.filter(r => r.frequency === 'monthly').reduce((s,r) => s + r.amount, 0);

    for (let i = 0; i < 6; i++) {
        const d = new Date();
        d.setUTCMonth(d.getUTCMonth() + i, 1);
        labels.push(d.toLocaleString('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' }));
        
        let monthExpenses = totalMonthlyRecurring;
        recurringExpenses.forEach(rec => {
            if (rec.frequency === 'yearly') {
                const startDate = new Date(rec.startDate + 'T00:00:00Z');
                if (startDate.getUTCMonth() === d.getUTCMonth()) {
                    monthExpenses += rec.amount;
                }
            }
        });
        
        projectedIncomeData.push(avgIncome.toFixed(2));
        projectedExpenseData.push(monthExpenses.toFixed(2));
    }
    
    chartInstances.cashFlowProjection = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Receita Projetada', data: projectedIncomeData, backgroundColor: 'rgba(34, 197, 94, 0.7)' },
                { label: 'Despesa Projetada', data: projectedExpenseData, backgroundColor: 'rgba(239, 68, 68, 0.7)' }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: false }, y: { stacked: false } } }
    });
}
function updateBudgetBurnDownChart() {
    if (!isUIReady) return;
    const ctx = document.getElementById('budgetBurnDownChart')?.getContext('2d');
    if (!ctx) return;

    const category = document.getElementById('budget-category-select').value;
    const budgetAmount = parseFloat(document.getElementById('budget-amount-input').value) || 0;

    if (!category || budgetAmount <= 0) {
        if(chartInstances.budgetBurnDown) chartInstances.budgetBurnDown.destroy();
        return;
    }

    const now = new Date();
    const currentMonth = now.getUTCMonth();
    const currentYear = now.getUTCFullYear();
    
    const expensesInMonth = transactions.filter(t => {
        const tDate = new Date(t.date + 'T00:00:00Z');
        return t.type === 'expense' && t.category === category && tDate.getUTCMonth() === currentMonth && tDate.getUTCFullYear() === currentYear;
    });
    
    const totalSpent = expensesInMonth.reduce((sum, expense) => sum + expense.amount, 0);

    chartInstances.budgetBurnDown = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [category],
            datasets: [
                {
                    label: 'Gasto',
                    data: [totalSpent],
                    backgroundColor: totalSpent > budgetAmount ? '#ef4444' : '#3b82f6',
                    borderColor: totalSpent > budgetAmount ? '#b91c1c' : '#2563eb',
                    borderWidth: 1,
                    barPercentage: 0.5
                },
                {
                    label: 'Orçamento',
                    data: [budgetAmount],
                    backgroundColor: 'rgba(209, 213, 219, 0.5)',
                    borderColor: 'rgba(156, 163, 175, 1)',
                    borderWidth: 1,
                    barPercentage: 0.5
                }
            ]
        },
        options: { 
            indexAxis: 'y',
            responsive: true, 
            maintainAspectRatio: false,
            scales: {
                x: {
                    stacked: false,
                    beginAtZero: true,
                },
                y: {
                    stacked: false,
                }
            },
            plugins: {
                legend: {
                    display: false
                }
            }
        }
    });
}


// --- Funções de Lógica de Negócio (CRUD) ---
async function deleteTransaction(id) { 
    showConfirmation('Tem certeza que deseja excluir esta transação?', async () => {
        await deleteDoc(doc(db, `users/${userId}/transactions/${id}`));
    });
}
async function deleteAccount(id) {
    const account = accounts.find(a => a.id === id);
    if (!account) return;

    const message = `Tem certeza que quer deletar a conta "${account.name}"? Todas as transações associadas serão removidas permanentemente.`;
    
    showConfirmation(message, async () => {
        const getPath = (coll) => `users/${userId}/${coll}`;
        const batch = writeBatch(db);

        batch.delete(doc(db, getPath('accounts'), id));

        const q = query(collection(db, getPath('transactions')), where("accountId", "==", id));
        const querySnapshot = await getDocs(q);
        querySnapshot.forEach((doc) => {
            batch.delete(doc.ref);
        });

        if (account.currentValue > 0) {
            batch.set(doc(collection(db, getPath('transactions'))), {
                description: `Saldo final da conta excluída: ${account.name}`,
                amount: account.currentValue,
                type: 'income',
                category: 'Outros',
                date: new Date().toISOString().split('T')[0]
            });
        }
        
        await batch.commit().catch(e => console.error("Error deleting account:", e));
    });
}
async function deleteRecurringExpense(id) {
    showConfirmation('Tem certeza que deseja excluir esta despesa recorrente?', async () => {
        await deleteDoc(doc(db, `users/${userId}/recurringExpenses/${id}`));
    });
}

// --- Modal Handlers & Forms ---
function setupAccountActionModal(id, action) {
     const account = accounts.find(a => a.id === id);
     if (!account) return;
    const modal = document.getElementById('account-action-modal');
    const form = modal.querySelector('form');
    form.reset();
    modal.querySelector('#account-action-id').value = id;
    modal.querySelector('#account-action-type').value = action;
    modal.querySelector('#account-action-name').textContent = account.name;
    const titleEl = modal.querySelector('#account-action-title');
    const labelEl = modal.querySelector('#account-action-label');
    const amountInput = modal.querySelector('#account-action-amount');
    
    const actions = {
        update: { title: 'Atualizar Valor Total', label: 'Novo valor total da conta', value: account.currentValue.toFixed(2) },
        withdraw: { title: 'Resgatar da Conta', label: 'Valor a resgatar', value: '' },
        deposit: { title: 'Aportar na Conta', label: 'Valor a aportar', value: '' }
    };
    
    titleEl.textContent = actions[action].title;
    labelEl.textContent = actions[action].label;
    amountInput.value = actions[action].value;
    openModal('account-action-modal');
}

function openEditTransaction(id) {
    const t = transactions.find(x => x.id === id);
    if (!t) return;

    // Aportes/resgates mexem no saldo da caixinha; editar aqui desajustaria o valor
    if (t.accountId || t.category === 'Investimento (Aporte)' || t.category === 'Resgate Guardado') {
        alert('Transações ligadas a uma conta (aportes e resgates) não podem ser editadas aqui. Para corrigir o valor, use "Atualizar" em Gerenciar Contas.');
        return;
    }

    document.getElementById('transaction-form').reset();
    document.getElementById('transaction-id').value = t.id;
    document.getElementById('transaction-modal-title').textContent = 'Editar Transação';
    document.getElementById('description').value = t.description;
    document.getElementById('amount').value = Number(t.amount).toFixed(2);
    document.getElementById('type').value = t.type;
    updateCategoryDropdown();

    const catSelect = document.getElementById('category');
    if (![...catSelect.options].some(o => o.value === t.category)) {
        catSelect.insertAdjacentHTML('afterbegin', `<option value="${t.category}">${t.category}</option>`);
    }
    catSelect.value = t.category;
    togglePaymentOptions();

    if (t.type === 'expense') {
        document.getElementById('payment-method').value = getPaymentMethod(t);
    }

    const dateInput = document.getElementById('date');
    dateInput.value = t.date;
    dateInput.disabled = !!t.recurringExpenseId;

    openModal('transaction-modal');
}

// --- Event Listeners ---
function setupEventListeners() {  

    const filterIds = ['filter-date-from', 'filter-date-to', 'filter-category', 'filter-payment'];
    filterIds.forEach(id =>
        document.getElementById(id).addEventListener('change', renderTransactionList)
    );
    document.getElementById('clear-filters-btn').onclick = () => {
        filterIds.forEach(id => document.getElementById(id).value = '');
        renderTransactionList();
    };

    // Modal Buttons
    document.querySelectorAll('.close-modal-btn').forEach(btn => btn.onclick = closeModal);
    document.getElementById('addTransactionBtn').onclick = () => {
    document.getElementById('transaction-form').reset();
    document.getElementById('transaction-id').value = '';
    document.getElementById('transaction-modal-title').textContent = 'Adicionar Nova Transação';
    const dateInput = document.getElementById('date');
    dateInput.disabled = false;
    dateInput.valueAsDate = new Date();
    updateCategoryDropdown();
    openModal('transaction-modal');};
    document.getElementById('manageRecurringExpensesBtn').onclick = () => openModal('manage-recurring-expenses-modal');
    document.getElementById('manageAccountsBtn').onclick = () => {
        document.getElementById('add-account-form').reset();
        document.getElementById('deduct-from-balance').checked = true; // Reset checkbox
        openModal('manage-accounts-modal');
    };
    document.getElementById('addNewRecurringExpenseBtn').onclick = () => { 
        document.getElementById('recurring-expense-form').reset(); 
        document.getElementById('recurring-start-date').valueAsDate = new Date();
        const checkbox = document.getElementById('is-installment-checkbox');
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change')); // Ensure sections are correctly shown/hidden
        openModal('recurring-expense-form-modal'); 
    };
    
    // Form Controls
    document.getElementById('type').onchange = updateCategoryDropdown;
    document.getElementById('category').onchange = togglePaymentOptions;
    document.getElementById('investment-account-select').onchange = updateInvestmentGrowthChart;
    document.getElementById('investment-rate').oninput = updateInvestmentGrowthChart;
    document.getElementById('budget-category-select').onchange = updateBudgetBurnDownChart;
    document.getElementById('budget-amount-input').oninput = updateBudgetBurnDownChart;
    document.getElementById('is-installment-checkbox').onchange = (e) => {
        document.getElementById('recurring-frequency-section').classList.toggle('hidden', e.target.checked);
        document.getElementById('installments-count-section').classList.toggle('hidden', !e.target.checked);
    };

    // Form Submissions
    document.getElementById('transaction-form').onsubmit = async (e) => {
        e.preventDefault();
        const newTransaction = {description: e.target.description.value, amount: parseFloat(e.target.amount.value),type: e.target.type.value, category: e.target.category.value, date: e.target.date.value,
        
        paymentMethod: e.target.type.value === 'expense'
        ? e.target['payment-method'].value
        : null
        };

        const editingId = e.target['transaction-id'].value;
        if (editingId) {
            if (['Investimento (Aporte)', 'Resgate Guardado'].includes(newTransaction.category)) {
                alert('Para aportes e resgates, use os botões da conta em Gerenciar Contas.');
                return;
            }
            const original = transactions.find(t => t.id === editingId);
            const { date, ...changes } = newTransaction;
            if (!original?.recurringExpenseId) changes.date = date;

            await updateDoc(doc(db, `users/${userId}/transactions/${editingId}`), changes);
            closeModal();
            return;
        }

        const batch = writeBatch(db);
        batch.set(doc(collection(db, `users/${userId}/transactions`)), newTransaction);
        if (newTransaction.category === 'Investimento (Aporte)') {
            const accountId = e.target['account-select'].value;
            const account = accounts.find(a => a.id === accountId);
            if (account) {
                batch.update(doc(db, `users/${userId}/accounts/${accountId}`), { currentValue: account.currentValue + newTransaction.amount });
            }
        }
        await batch.commit();
        closeModal();
    };
    document.getElementById('add-account-form').onsubmit = async (e) => { 
        e.preventDefault();
        const newAccount = {
            name: e.target['account-name'].value,
            currentValue: parseFloat(e.target['account-initial-value'].value) || 0,
            goalAmount: parseFloat(e.target['account-goal'].value) || 0,
            createdAt: new Date(),
        };
        const deduct = e.target['deduct-from-balance'].checked;
        const batch = writeBatch(db);
        const newAccRef = doc(collection(db, `users/${userId}/accounts`));
        batch.set(newAccRef, newAccount);
        
        if (newAccount.currentValue > 0 && deduct) {
            batch.set(doc(collection(db, `users/${userId}/transactions`)), {
                description: `Aporte inicial - ${newAccount.name}`, amount: newAccount.currentValue, type: 'expense', category: 'Investimento (Aporte)', date: new Date().toISOString().split('T')[0],
                accountId: newAccRef.id
            });
        }
        await batch.commit();
        e.target.reset();
    };
    document.getElementById('account-action-form').onsubmit = async (e) => {
        e.preventDefault();
        const id = e.target['account-action-id'].value;
        const action = e.target['account-action-type'].value;
        const amount = parseFloat(e.target['account-action-amount'].value);
        const account = accounts.find(a => a.id === id);
        if (!account) return;
        
        const batch = writeBatch(db);
        const accRef = doc(db, `users/${userId}/accounts/${id}`);
        const transColl = collection(db, `users/${userId}/transactions`);
        
        if (action === 'update') {
            const diff = amount - account.currentValue;
            if (diff !== 0) batch.set(doc(transColl), { description: `${diff > 0 ? 'Rendimento' : 'Ajuste'} - ${account.name}`, amount: Math.abs(diff), type: diff > 0 ? 'income' : 'expense', category: 'Rendimentos', date: new Date().toISOString().split('T')[0], accountId: id });
            batch.update(accRef, { currentValue: amount });
        } else if (action === 'withdraw') {
            batch.set(doc(transColl), { description: `Resgate - ${account.name}`, amount, type: 'income', category: 'Resgate Guardado', date: new Date().toISOString().split('T')[0], accountId: id });
            batch.update(accRef, { currentValue: account.currentValue - amount });
        } else if (action === 'deposit') {
            batch.set(doc(transColl), { description: `Aporte - ${account.name}`, amount, type: 'expense', category: 'Investimento (Aporte)', date: new Date().toISOString().split('T')[0], accountId: id });
            batch.update(accRef, { currentValue: account.currentValue + amount });
        }
        await batch.commit();
        closeModal();
    };
    document.getElementById('recurring-expense-form').onsubmit = async (e) => {
        e.preventDefault();
        const isInstallment = e.target['is-installment-checkbox'].checked;
        const description = e.target['recurring-description'].value;
        const totalAmount = parseFloat(e.target['recurring-amount'].value);
        const category = e.target['recurring-category'].value;
        const startDate = e.target['recurring-start-date'].value;
        const paymentMethod = e.target['recurring-payment-method'].value;

        if (isInstallment) {
            const installmentCount = parseInt(e.target['installments-count'].value);
            if (!installmentCount || installmentCount < 2) {
                alert('O número de parcelas deve ser 2 ou maior.');
                return;
            }
            const installmentValue = totalAmount / installmentCount;
            const batch = writeBatch(db);
            const firstDate = new Date(startDate + 'T00:00:00Z');
            for (let i = 0; i < installmentCount; i++) {
                const installmentDate = new Date(firstDate);
                installmentDate.setUTCMonth(firstDate.getUTCMonth() + i);
                const newTransaction = {
                    description: `${description} (${i + 1}/${installmentCount})`,
                    amount: installmentValue,
                    type: 'expense',
                    category: category,
                    date: installmentDate.toISOString().split('T')[0],
                paymentMethod: paymentMethod
                };
                batch.set(doc(collection(db, `users/${userId}/transactions`)), newTransaction);
            }
            await batch.commit();

        } else {
           const newExpense = {
                description,
                amount: totalAmount,
                category,
                startDate,
                frequency: e.target['recurring-frequency'].value,
                paymentMethod: paymentMethod
            };
            await addDoc(collection(db, `users/${userId}/recurringExpenses`), newExpense);
        }
        closeModal();
    };
}
// --- Iniciar a Aplicação ---
document.addEventListener('DOMContentLoaded', initializeFinanceApp);
