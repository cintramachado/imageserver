# imageServer

Aplicação React + Node para navegação de diretórios e seleção de imagens com download em ZIP.

## Operação com Docker (recomendado)

- Subir stack (build + run):
	- `docker compose up --build`
- Rodar em background:
	- `docker compose up -d --build`
- Ver logs em tempo real:
	- `docker compose logs -f`
- Parar e remover containers/rede:
	- `docker compose down`
- Rebuild limpo da imagem:
	- `docker compose build --no-cache`

## Endereços

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

## Observações

- O backend usa a pasta local `Documents` do Windows montada no container via `docker-compose.yml`.
- Se precisar acesso por outro dispositivo na rede, libere as portas `5173` e `3001` no firewall do Windows.

## Auditoria de Logs

- Backend: grava logs estruturados em `backend/logs/audit.log.ndjson`.
- Frontend: captura erros de carregamento, download, `window.error` e `unhandledrejection`.
- Endpoint de ingestão: `POST /api/audit` no backend.
- Correlação: cada resposta HTTP inclui `X-Request-Id` para rastreabilidade.
