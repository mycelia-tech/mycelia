# Networking & Reverse Proxy

Mycelia uses Nginx as a reverse proxy to provide a single entry point for the application, handle SSL/TLS, and route traffic between the frontend and backend.

## Architecture

By default, Nginx listens on port `4433` (HTTPS) and routes traffic as follows:

- `/api/*`, `/ws/*`, `/oauth/*`, `/v1/*`, etc. → `backend:5173`
- Everything else → `frontend:8080`

## Configuration

### Ports

Nginx is the application entry point. Its host ports can be customized via
`.env`; frontend, backend, and worker ports stay internal to the Compose
network.

| Endpoint | Environment Variable | Default Port | Description |
|----------|----------------------|--------------|-------------|
| **Nginx HTTPS** | `NGINX_PORT` | `4433` | Primary application entry point |
| **Nginx HTTP** | `NGINX_HTTP_PORT` | `3210` | Plain-HTTP local entry point |
| **MongoDB** | internal only | `27017` | Optional `docker-compose.mongo-local.yml` publishes loopback only |

### SSL / Certificates

Nginx is configured to use SSL. For local development, you can generate a self-signed certificate:

```bash
# Generate self-signed certificates in misc/nginx/ssl/
./misc/nginx/generate-self-signed.sh
```

The certificates are stored in `misc/nginx/ssl/` and are automatically ignored by git.

#### Custom Certificates
To use your own certificates (e.g., from Let's Encrypt), place them in `misc/nginx/ssl/`:
- `fullchain.pem`
- `privkey.pem`

## Direct Service Access

Frontend, backend, and Python worker are reachable by their service names only
inside the Compose network. Host access goes through Nginx; MongoDB is the only
application dependency with a direct development port.

- **HTTP proxy**: [http://localhost:3210](http://localhost:3210)
- **Proxy**: [https://localhost:4433](https://localhost:4433) (Note: use `https://`)

## Troubleshooting

### "Privacy Error" in Browser
When using self-signed certificates, your browser will show a warning (e.g., `NET::ERR_CERT_AUTHORITY_INVALID`). You can usually bypass this by clicking "Advanced" and then "Proceed to localhost (unsafe)".

### WebSocket Connections
If you are behind an additional proxy (like Cloudflare or another Nginx instance), ensure that `Upgrade` and `Connection` headers are correctly forwarded to support WebSockets.
