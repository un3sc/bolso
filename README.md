# Organizador Financeiro (template)

Painel financeiro pessoal feito só com HTML, CSS e JavaScript puro, usando Firebase (Authentication + Firestore). Cada pessoa cria a própria conta e vê **apenas o seu orçamento**.

Este projeto é um template livre (licença MIT): faça fork, configure o seu Firebase e use do jeito que quiser.

## O que tem

- Login, cadastro e recuperação de senha (e-mail e senha)
- Dados separados por usuário: cada conta só lê e escreve nos próprios dados
- Transações de receita e despesa, com edição, exclusão e filtros por data, categoria e forma de pagamento
- Despesas recorrentes e parceladas (lançadas automaticamente)
- Contas/caixinhas com objetivo e saldo VR
- Gráficos: receitas vs despesas, despesas por categoria e por forma de pagamento, projeção de fluxo de caixa, projeção anual, queima de orçamento e simulador de investimentos
- Tema escuro e claro

## Tecnologias

JavaScript (ES modules), Tailwind CSS (CDN), Chart.js (CDN), Firebase Authentication e Cloud Firestore.

## Como configurar

Você precisa de uma conta Google e de um projeto no Firebase (o plano gratuito, Spark, é suficiente para começar).

### 1. Criar o projeto e o app web

1. Acesse o [Firebase Console](https://console.firebase.google.com/) e clique em **Adicionar projeto**.
2. Dentro do projeto, clique no ícone **Web (`</>`)** para registrar um app web (não precisa ativar o Hosting).
3. Copie o objeto `firebaseConfig` que aparece.

### 2. Preencher o `firebase-config.js`

Substitua os valores de exemplo pelos do seu projeto. Esses valores **não são segredos**: eles só identificam o projeto. Quem protege os dados são as regras do Firestore (passo 4).

### 3. Ativar o login por e-mail e senha

No Firebase Console: **Authentication > Vamos começar > Sign-in method > E-mail/senha > Ativar**.

> Se esse passo for esquecido, o cadastro falha com a mensagem "O login por e-mail/senha não está ativado".

### 4. Criar o Firestore e publicar as regras

1. **Firestore Database > Criar banco de dados** (escolha a região mais próxima de você).
2. Abra a aba **Regras**, cole o conteúdo do arquivo `firestore.rules` e clique em **Publicar**.

As regras permitem que cada usuário acesse somente `users/{seu uid}/...`. Sem elas (ou com regras abertas), outras pessoas poderiam ver os seus dados.

### 5. Autorizar o domínio do site

Em **Authentication > Settings > Authorized domains**, adicione o domínio onde o site vai rodar (por exemplo `seuusuario.github.io` ou `seusite.netlify.app`). `localhost` já vem autorizado.

## Rodando localmente

Como o projeto usa ES modules, não abra o `index.html` com duplo clique. Use um servidor local:

```bash
# Python
python -m http.server 8000

# ou Node
npx serve
```

Depois acesse `http://localhost:8000`.

## Publicando

É um site estático, então funciona em qualquer hospedagem estática (GitHub Pages, Netlify, Vercel, Firebase Hosting). Lembre de autorizar o domínio (passo 5).

## Como os dados são organizados

```
users/{uid}/transactions/{id}
users/{uid}/recurringExpenses/{id}
users/{uid}/accounts/{id}
```

O `uid` é gerado pelo Firebase Authentication quando a pessoa cria a conta. O `script.js` usa esse `uid` em todos os caminhos, e as regras do Firestore garantem que ninguém acesse o `uid` de outra pessoa.

## Estrutura dos arquivos

| Arquivo | Para que serve |
| --- | --- |
| `index.html` | Tela de login/cadastro, painel e modais |
| `auth.js` | Login, cadastro, recuperação de senha e logout |
| `script.js` | Lógica do painel (dados, gráficos, filtros) |
| `style.css` | Temas claro/escuro e estilos |
| `firebase-config.js` | Configuração do seu projeto Firebase |
| `firestore.rules` | Regras de segurança do Firestore |

## Observações

- Quem hospeda o site usa o próprio projeto Firebase, então as cotas gratuitas (leituras, escritas, usuários) são do dono do projeto.
- O cadastro é aberto: qualquer pessoa com o link pode criar uma conta. Se quiser restringir, desative o provedor depois de criar as contas necessárias ou adicione verificação de e-mail.
- Os dados ficam no Firebase, não no navegador. Fazer logout limpa tudo da tela.

## Licença

MIT. Veja o arquivo `LICENSE`.
