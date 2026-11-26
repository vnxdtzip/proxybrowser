# Unleashed Browser — lab xpsec academy

Navegador Electron mínimo que força **todo** o tráfego por um proxy HTTPS.
Cenário do lab: o aluno precisa dar bypass em filtragem (Umbrella de teste
bloqueando navegadores ≠ Edge/Chrome; ManageEngine de teste bloqueando sites).
**Somente em VM de laboratório — nunca em rede de produção.**

> Por que Electron fura o bloqueio de navegador: o Electron **não lê** as policies
> do Chrome (`HKLM\...\Policies\Google\Chrome`) nem do Edge. Regras de GPO/Umbrella
> que valem "para o Chrome" não se aplicam. E o processo chama `Unleashed Browser.exe`,
> não `firefox.exe`/`brave.exe` — blocklist por nome de processo erra o alvo.

## Estrutura

```
config.json            parâmetros do proxy + hardening (NÃO versionar)
src/main.js            processo principal: proxy HTTPS, auth, anti-leak
src/preload.js         ponte segura p/ a UI
src/index.html         chrome do navegador (barra + webview + status)
src/renderer.js        navegação e estado de conexão
server/gen-cert.js     gera cert self-signed do proxy
server/proxy-server.js proxy HTTPS forward com auth Basic (endpoint do lab)
```

## Config (`config.json`)

```jsonc
{
  "proxy": { "scheme":"https", "host":"127.0.0.1", "port":8443,
             "username":"aluno", "password":"troque-isto" },
  "hardening": {
    "disableQuic": true,     // mata HTTP/3 (nada escapa por UDP:443)
    "failClosedDns": false,  // true = resolução local falha (prova anti-leak DNS)
    "webrtcNoLeak": true,    // não expõe IP local via WebRTC
    "spkiPin": ""            // cole o SPKI do proxy p/ confiar SÓ nele
  },
  "homePage": "https://example.com"
}
```

No lab real troque `host` pelo IP da VM do proxy e use uma senha de verdade.

---

## Incremento 1 — o navegador roda e escapa do bloqueio de navegador

```bash
npm start
```

**Teste:** a janela abre e navega? Então o Electron rodou onde Firefox/Brave
seriam barrados. Rode também o `.exe` empacotado (incremento 4) na VM com o
Umbrella de teste ativo e confirme que ele **não** é bloqueado como "navegador
não autorizado". É o primeiro achado: o controle filtra por produto/por nome,
não por comportamento.

*(Neste ponto o proxy aponta p/ 127.0.0.1:8443, que ainda não existe — a
navegação vai falhar com `ERR_PROXY_CONNECTION_FAILED`. Isso é esperado e já
demonstra o **fail-closed**: sem proxy, não há saída direta. Suba o proxy no
incremento 3.)*

## Incremento 2 — proxy forçado + anti-leak (já está no código)

Tudo em `src/main.js`:
- `session.setProxy({ proxyRules: "https://host:port" })` → proxy HTTPS p/ todos
  os esquemas. O `CONNECT destino:443` viaja **dentro do TLS** até o proxy, então
  DPI/firewall no caminho não leem o hostname em claro.
- `app.on('login')` responde o `407` com as credenciais (Basic).
- `disable-quic` + WebRTC travado → sem caminhos alternativos fora do proxy.

**Teste de leak (o mais importante do lab):** derrube o proxy e navegue. Tem que
dar `ERR_PROXY_CONNECTION_FAILED` e **nada** sair pela rede. Confirme no Wireshark
da VM: fora o tráfego para o IP:porta do proxy, não deve haver conexão direta a
sites nem consultas DNS dos domínios visitados. Para o teste estrito de DNS,
ligue `failClosedDns: true`.

## Incremento 3 — o proxy do lab

```bash
node server/gen-cert.js        # gera server/certs/proxy-*.pem (SAN já correto)
node server/proxy-server.js    # sobe o proxy e imprime o SPKI pin
```

O servidor loga cada `CONNECT`/`HTTP` — útil pra mostrar ao aluno que o tráfego
realmente passou por ali. Exige credencial (sem ela → `407`).

### Confiança no certificado (escolha uma)

O Chromium valida o TLS do proxy contra o store do Windows. Cert self-signed
falha com `ERR_CERT_AUTHORITY_INVALID` até você resolver isso:

- **SPKI pin (rápido, recomendado p/ lab):** copie o `SPKI pin` que o servidor
  imprime e cole em `config.json → hardening.spkiPin`. O cliente passa a confiar
  **apenas** naquele certificado. Muito melhor que `--ignore-certificate-errors`,
  que desligaria toda a validação.
- **Store do Windows (mais realista):** importe o cert na raiz confiável da VM:
  ```powershell
  Import-Certificate -FilePath server\certs\proxy-cert.pem `
    -CertStoreLocation Cert:\CurrentUser\Root
  ```

## Incremento 4 — empacotar como `.exe` não assinado (teste de app control)

```bash
npm run package
# saída: dist/Unleashed Browser-win32-x64/Unleashed Browser.exe
```

**Teste de controle de aplicação:** copie a pasta para `%LOCALAPPDATA%` na VM e
rode o `.exe`. O que acontece decide o achado:
- Roda → o controle é **blocklist** (por hash/publisher de navegadores conhecidos).
  Um binário novo e não assinado passa.
- É barrado → é **allowlist** (AppLocker/WDAC) ou a regra ASR do Defender
  "block executable unless prevalence/age/trusted". Aí o bypass morre no app
  control, e esse é o resultado a documentar.

---

## Checklist de achados (o que o lab ensina)

| Camada | Pergunta do teste | Onde |
|---|---|---|
| Bloqueio de navegador | Electron passa onde Firefox/Brave caem? | Inc. 1 |
| App control | `.exe` não assinado roda do `AppData`? | Inc. 4 |
| Egress / leak | Algo sai fora do proxy? DNS vaza? | Inc. 2 (Wireshark) |
| Inspeção TLS | Quem emite o cert visto na 443? | ver abaixo |

**Inspeção TLS:** se o Umbrella/SWG de teste fizer MITM, o cert que o navegador
recebe do "proxy" será o da CA do SWG, não o seu. Com `spkiPin` fixado, a conexão
**falha** em vez de vazar — o que já é o diagnóstico (há interceptação). Furar
isso exigiria uma camada de cifra própria dentro do HTTPS; fica para um
incremento posterior se o cenário do lab pedir.

## Segurança operacional do lab

- `config.json` e `server/certs/*.pem` estão no `.gitignore`. Não suba senha nem
  chave para o reppositório.
- Troque `password` antes de qualquer uso real.
- O proxy exige auth pra não virar proxy aberto mesmo dentro da VM.
