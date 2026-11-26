# Checklist de privacidade — Unleashed Browser

O que o navegador faz para limitar o que os sites conseguem acessar. Os itens
com toggle ficam no painel **Privacidade** (e **Circuito**, para vazamento de
rede); os "fixos" são sempre aplicados. Ajustes valem na hora, sem reiniciar
(exceto QUIC e DNS, que são de boot).

## Permissões de sites (painel Privacidade)

| Item | Padrão | Como |
|---|---|---|
| Câmera e microfone | **Bloqueado** | nega a permissão `media` a qualquer site |
| Localização | **Bloqueado** | nega `geolocation` |
| Notificações | **Bloqueado** | nega `notifications` |

Antes disso, o Electron concederia essas permissões sem controle — era o furo
principal (qualquer site pedia a webcam e recebia).

## Sempre bloqueado (sem toggle)

- **USB, HID, serial, Bluetooth** — acesso a dispositivos (`setDevicePermissionHandler` nega tudo).
- **Captura de tela** (`display-capture`) e **leitura de clipboard** (`clipboard-read`).
- **MIDI**, **sensores/idle-detection**, **window-management**, **abrir apps externos** (`openExternal`).
- Regra geral: o handler de permissão nega tudo o que não está explicitamente liberado.

Liberados por serem inofensivos à navegação: tela cheia, pointer/keyboard lock,
escrita higienizada de clipboard e DRM de streaming (`mediaKeySystem`).

## Vazamento de rede (painel Circuito)

| Item | Padrão | Observação |
|---|---|---|
| WebRTC | **Protegido** | `disable_non_proxied_udp` — não revela IP local |
| QUIC / HTTP3 | **Bloqueado** | fecha saída por UDP fora do proxy (reinicia p/ aplicar) |
| DNS fail-closed | Desligado | opcional; resolução local falha em vez de vazar (reinicia) |
| DNS no destino | sempre | o proxy resolve o host; o cliente não consulta DNS dos sites |

## Já garantido pela arquitetura

- **Todo o tráfego sai pelo proxy** (regra de sessão), com túnel TLS até ele.
- **IP de saída = o da VPS**, verificável no painel Circuito.
- As permissões e settings são por máquina (`settings.json` no `userData`),
  não embutidas no binário.

## Fora de escopo (não implementado)

Anti-fingerprint de canvas/fontes/tela, spoof de fuso/idioma, bloqueio de
cookies de terceiros e limpeza automática de dados ao sair. Dá para adicionar se
o cenário do lab pedir.
