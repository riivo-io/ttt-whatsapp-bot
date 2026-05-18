# Running the bot locally

Two processes need to be up: the Node server on `:3001` and an ngrok tunnel pointing Meta's webhook at it.

## Start

```bash
# Terminal 1 — server
npm run dev

# Terminal 2 — public tunnel (static domain configured on the ngrok account)
ngrok http --url=sufferable-gracelynn-polytrophic.ngrok-free.dev 3001
```

`npm run dev` runs `nodemon --exec ts-node src/server.ts`. **Cold start takes ~60–90s** before the `🚀 TTT WhatsApp Tax Bot server running on port 3001` line appears — ts-node has to compile the full module graph. The process sits at 0% CPU during much of that window. Don't kill it early.

You'll know it's ready when you see:

```
🚀 TTT WhatsApp Tax Bot server running on port 3001
📱 Webhook endpoint: http://localhost:3001/webhook
📄 PDF downloads:   http://localhost:3001/api/pdf
```

## Verify

```bash
curl http://localhost:3001/health
curl https://sufferable-gracelynn-polytrophic.ngrok-free.dev/health
```

Both should return `{"status":"ok","timestamp":"..."}`.

## If startup looks stuck

Before assuming the server is hung, check whether a previous run left a zombie behind:

```bash
lsof -i :3001 -sTCP:LISTEN -n -P     # who's on the port (if anyone)
pgrep -fl "ts-node|nodemon|server\.ts"
```

A common failure mode: an old `ts-node` process is alive (sometimes for days) but no longer listening on `:3001`. `npm run dev` will then start nodemon successfully but the new ts-node never binds because… actually it does bind, it just takes a while. The real giveaway for a *real* hang is no log output and no port bind after **2+ minutes**. Anything under that — wait.

To clear stale state:

```bash
pkill -f "ts-node.*server\.ts"
pkill -f nodemon
pkill -f "ngrok http"
```

Then restart both processes.

## Stop

`Ctrl+C` in each terminal. The server has SIGINT/SIGTERM handlers that close cleanly.
