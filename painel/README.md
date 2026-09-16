# Painel do Validador

Interface para ver o estado dos hangares e editar as configurações que são
seguras de mexer pela web.

## Como acessar

O painel **escuta apenas em `127.0.0.1`**. Nada deste sistema está exposto à
internet — a porta do n8n é fechada e a Evolution só atende localhost — e um
painel que controla validação de estacionamento, com efeito financeiro, não é
lugar para abrir a primeira brecha.

O acesso é por túnel SSH. No seu computador:

```bash
ssh -i ~/.ssh/validador.pem -L 8081:127.0.0.1:8081 ubuntu@3.136.166.82
```

Deixe esse terminal aberto e abra <http://localhost:8081> no navegador. A senha
está em `PAINEL_SENHA`, no `.env` do servidor (usuário pode ser qualquer coisa).

## O que dá para editar

| Campo | Regra |
| --- | --- |
| `cotaMensalForaPrazo` | inteiro, 0 a 100 |
| `diasValidacaoPadrao` | inteiro, 0 a **20** — teto do slider do ValidPark, sem folga |
| `prazoValidacaoHoras` | número de horas, ou vazio para sem limite |
| `placaGenerica` | `AAA1234` ou `AAA1A23` |
| `grupoWhatsappId` | termina em `@g.us`. **Sem ele o hangar não recebe nada** |
| `grupoAdministracao` | `@g.us` (grupo) ou `@s.whatsapp.net` (pessoa) |
| `exigeFotoVeiculoNoLocal` | sim/não — antifraude, hoje só AIBM 1 e 2 |

A validação que vale é a do servidor, não a da tela.

## O que NÃO dá para editar, de propósito

- **Credenciais dos hangares** — ficam no `.env`, nunca numa tela web.
- **Seletores CSS da página** — são código disfarçado de configuração. Um
  seletor errado quebra o hangar em silêncio, sem erro visível.
- **Dados do Asaas** — erro ali emite cobrança para o CNPJ errado.

## Cada alteração vira um commit

O `config/hangares.json` é versionado desde 09/09/2026, depois que a versão
fora do git divergiu em silêncio e deixou produção semanas com seletores de
slider quebrados. Se o painel editasse o arquivo sem commitar, o próximo
`git pull` conflitaria ou sobrescreveria — o mesmo problema de volta.

Commitando, o git segue sendo a fonte da verdade e o histórico vira auditoria:
quem mudou a cota do Alljet, quando, e de quanto para quanto. Se o commit
falhar, a escrita é desfeita — o arquivo nunca fica divergindo do git.

**O servidor não tem credencial de escrita no GitHub**, então o push não
acontece: os commits ficam locais e o painel mostra quantos estão pendentes de
envio. As mudanças valem em produção normalmente; o que falta é só o envio para
o repositório remoto. Para resolver de vez, é preciso cadastrar uma deploy key
do servidor no GitHub.

## Não há "esqueci minha senha"

Foi implementado e **removido em 16/09/2026**, porque não funcionava: o SMTP da
Locaweb recusa autenticação a partir deste servidor com
`535 5.7.8 authentication failed`, embora as mesmas credenciais funcionem no
webmail.

O diagnóstico descartou as causas simples — testadas as quatro combinações de
usuário (completo e sem domínio) e método (PLAIN e LOGIN), todas recusadas, com
a conexão e o STARTTLS funcionando. A explicação mais provável é bloqueio por
origem: o servidor está na AWS, nos Estados Unidos, e provedores brasileiros
costumam recusar SMTP de IP estrangeiro ou de nuvem.

As rotas de recuperação eram **públicas, sem autenticação**, num painel exposto
à internet. Mantê-las sem funcionar seria superfície de ataque por nada.

**Como recuperar acesso hoje:** outra conta de administrador redefine a senha
pelo painel. Por isso o painel avisa enquanto existir uma conta só — com apenas
uma, perder a senha significa voltar editando arquivo no servidor por SSH.

Se um dia for necessário, o caminho é o **Amazon SES**: o servidor já está na
AWS e alcança o SES na porta 587 (testado). Exige verificar o domínio e sair do
sandbox.

## Serviço

```bash
sudo systemctl status painel-validador
sudo systemctl restart painel-validador
sudo journalctl -u painel-validador -f
```

## Se um dia for exposto à internet

Hoje não é, e essa é a proteção principal. Antes de expor, três coisas:

1. **Domínio e TLS.** Let's Encrypt não emite certificado para IP, então é
   preciso um domínio. Sem TLS, a senha trafega legível.
2. **Autenticação melhor que Basic.** Funciona atrás de túnel; exposto, quer
   sessão, limite de tentativas e registro de acesso.
3. **Resolver o webhook do n8n.** Ele não tem autenticação nenhuma (ver
   `docs/perguntas-abertas.md`): quem descobrir a URL valida ticket em qualquer
   hangar. Não faz sentido blindar o painel e deixar essa porta aberta.
