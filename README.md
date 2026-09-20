# Tab Story sync server

Server-authoritative Socket.IO sync for the Tab Story PWA and browser extension.

## Run locally

1. Copy `.env.example` to `.env` and set the secrets.
2. Run `docker compose up -d`.
3. Run `npm install`, `npx prisma db push`, then `npm run dev`.

Clients authenticate in the Socket.IO handshake with `accessToken` and `refreshToken`, send `sync` with `{ changes, cursor }`, and receive authoritative push results followed by paginated pull pages. Saving and synchronizing tabs is available on the free plan; account tier is used for premium features such as AI Tools.
