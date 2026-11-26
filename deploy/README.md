# Setup do proxy na VPS + ambiente do lab

Guia passo a passo para o **aluno** subir o endpoint de proxy HTTPS em uma VPS e
preparar a VM cliente onde o `Unleashed Browser` roda. Serve ao lab da xpsec academy.

> ⚠️ **Escopo de laboratório.** Este proxy só deve receber tráfego da VM de lab
> do aluno. Nunca aponte uma rede corporativa de produção nem controles de
> terceiros para cá. Restrinja o acesso ao proxy por IP (Parte 5).

---

## Topologia

```
   VM cliente (Windows 11, lab)                     VPS (Linux)
   ┌───────────────────────────┐                   ┌────────────────────┐
   │  Unleashed Browser.exe          │                   │  proxy-server.js   │
   │  - Umbrella (teste)        │  TLS :8443        │  - Node (sem deps) │
   │  - ManageEngine (teste)    │ ════════════════▶ │  - auth Basic      │
   │  config.json (host=VPS,    │  CONNECT cifrado  │  - cert self-signed│
   │   spkiPin do cert)         │                   │  systemd           │
   └───────────────────────────┘                   └────────────────────┘
        navega → tudo sai pelo túnel          → abre a conexão ao destino real
```

O que viaja no fio entre cliente e VPS é **TLS para o proxy**; o `CONNECT
destino:443` vai dentro desse TLS, então um DPI no meio não lê o hostname.

---

## Pré-requisitos

- **VPS** Linux (Ubuntu 22.04/24.04 LTS de referência), com IP público. 1 vCPU /
  1 GB já basta para o lab.
- Acesso SSH à VPS.
- A **VM cliente** já com o repositório `Unleashed Browser` (ver README raiz).
- Decida uma **porta** (padrão `8443`; >1024 não precisa de root) e uma **senha**
  forte para o proxy.

> O proxy usa só módulos nativos do Node — **não há `npm install` na VPS**.

---

## Parte 1 — Preparar a VPS

SSH na VPS e instale o Node (LTS via NodeSource):

```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt -y install nodejs
node -v        # confirme (>= 18)
```

Crie um usuário de serviço sem shell de login e o diretório do app:

```bash
sudo useradd --system --home /opt/proxy-browser --shell /usr/sbin/nologin proxylab
sudo mkdir -p /opt/proxy-browser
```

## Parte 2 — Enviar os arquivos do proxy

Na VPS só são necessários: `config.json`, a pasta `server/` e a pasta `deploy/`.
Da sua máquina (ou da VM cliente), copie via `scp`:

```bash
# rode no diretório do repositório, ajustando USER@VPS
scp -r config.json server deploy USER@VPS:/tmp/pb-deploy/
```

Na VPS, mova para o destino e ajuste dono:

```bash
sudo cp -r /tmp/pb-deploy/* /opt/proxy-browser/
sudo chown -R proxylab:proxylab /opt/proxy-browser
rm -rf /tmp/pb-deploy
```

## Parte 3 — Configurar e gerar o certificado

Edite `config.json` na VPS com o **IP público da VPS** e uma senha real. O host
entra no SAN do certificado, então precisa bater com o que o cliente vai usar:

```bash
sudo -u proxylab nano /opt/proxy-browser/config.json
```

```jsonc
{
  "proxy": {
    "scheme": "https",
    "host": "SEU.IP.PUBLICO.AQUI",   // IP público da VPS (ou domínio)
    "port": 8443,
    "username": "aluno",
    "password": "UMA-SENHA-FORTE"
  }
  // o bloco "hardening"/"homePage" só é lido pelo cliente; ignorado aqui
}
```

Gere o cert (o SAN sai correto a partir do `host`):

```bash
cd /opt/proxy-browser
sudo -u proxylab node server/gen-cert.js
```

Isso cria `server/certs/proxy-cert.pem` e `proxy-key.pem`.

## Parte 4 — Rodar como serviço (systemd)

O arquivo `deploy/proxy-browser.service` já vem pronto (usuário `proxylab`,
WorkingDir `/opt/proxy-browser`, restart automático, sandbox do systemd).

```bash
sudo cp /opt/proxy-browser/deploy/proxy-browser.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now proxy-browser
sudo systemctl status proxy-browser --no-pager
```

Veja o log (ele imprime o **SPKI pin** no boot e cada CONNECT):

```bash
journalctl -u proxy-browser -n 30 --no-pager
```

Anote o `SPKI pin` — você vai colar no cliente na Parte 6.

> Teste rápido sem systemd (debug): `sudo -u proxylab node server/proxy-server.js`
> e `Ctrl+C` para parar.

## Parte 5 — Firewall (abrir a porta, restringindo a origem)

Abra a porta **somente** para o IP da VM de lab — evita virar proxy aberto.

No firewall da VPS (ufw):

```bash
sudo ufw allow from IP.DO.LAB to any port 8443 proto tcp
sudo ufw enable
sudo ufw status
```

E, se houver **security group** no provedor (AWS/GCP/Azure/DO), libere a mesma
porta TCP 8443 com origem restrita ao IP do lab. Os dois precisam permitir.

## Parte 6 — Configurar a VM cliente

No `config.json` do **cliente** (VM Windows), aponte para a VPS e cole o SPKI pin
do log da Parte 4:

```jsonc
{
  "proxy": {
    "scheme": "https",
    "host": "SEU.IP.PUBLICO.AQUI",   // mesmo IP/senha da VPS
    "port": 8443,
    "username": "aluno",
    "password": "UMA-SENHA-FORTE"
  },
  "hardening": {
    "disableQuic": true,
    "failClosedDns": false,
    "webrtcNoLeak": true,
    "spkiPin": "COLE-O-SPKI-PIN-DO-LOG"   // confia SÓ no cert da VPS
  },
  "homePage": "https://example.com"
}
```

Com o `spkiPin` preenchido não é preciso importar o cert no store do Windows.

## Parte 7 — Verificar a ponta a ponta

Da VM cliente, antes do navegador, teste o proxy com `curl` (ou o navegador
direto):

```bash
# espera 200; troque IP/porta/senha
curl -s -o /dev/null -w "%{http_code}\n" \
  -x "https://aluno:UMA-SENHA-FORTE@SEU.IP.PUBLICO:8443" \
  --proxy-insecure https://example.com/
```

Depois `npm start` e navegue. Na VPS, `journalctl -u proxy-browser -f` deve
mostrar o `CONNECT example.com:443` aparecendo em tempo real — prova de que o
tráfego passou pelo túnel.

---

## Checklist de aceitação

- [ ] `node -v` ≥ 18 na VPS
- [ ] `config.json` da VPS com IP público e senha real
- [ ] cert gerado; `systemctl status` = `active (running)`
- [ ] SPKI pin anotado e colado no cliente
- [ ] porta 8443 liberada **só** para o IP do lab (ufw + security group)
- [ ] `curl` via proxy retorna 200
- [ ] `CONNECT` aparece no `journalctl` ao navegar

## Troubleshooting

| Sintoma (no cliente) | Causa provável | Correção |
|---|---|---|
| `ERR_PROXY_CONNECTION_FAILED` | porta fechada / serviço parado | ufw + security group; `systemctl status` |
| `ERR_CERT_AUTHORITY_INVALID` | SPKI pin ausente/errado | copie o pin exato do log para o cliente |
| `407` / pede senha em loop | usuário/senha divergentes | iguale `config.json` dos dois lados |
| cert gerado mas conexão falha no IP | SAN sem o IP público | ajuste `host` na VPS e **regenere** o cert |
| `CONNECT` não aparece no log | tráfego saindo fora do proxy | cheque `proxyRules`; teste de leak no Wireshark |

## Encerrar / limpar o lab

```bash
sudo systemctl disable --now proxy-browser
sudo rm /etc/systemd/system/proxy-browser.service
sudo rm -rf /opt/proxy-browser          # remove cert/chave/config
sudo userdel proxylab
sudo ufw delete allow from IP.DO.LAB to any port 8443 proto tcp
```

> Op-sec do lab: a chave privada (`proxy-key.pem`) e a senha ficam só na VPS e na
> VM de lab; nunca versione. Ao encerrar o exercício, destrua a VPS para não
> deixar um endpoint de proxy exposto.
