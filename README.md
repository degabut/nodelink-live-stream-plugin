# NodeLink Live Stream plugin

## DISCLAIMER: THE CURRENT CODE BASE IS ENTIRELY VIBE-CODED

The current code base is entirely vibe-coded (with DS Flash v4.1), by that I mean it's written almost entirely by AI, with little to no code-review.

I've tested the plugin on my personal setup and it seems to work as expected, but I'm planning to de-slop it in the future.

**Use at your own risk.**

---

This plugin exposes the audio a NodeLink player is **currently broadcasting to Discord** as a plain
HTTP stream.

```http
GET /{sessionId}:{guildId}/stream        # Ogg Opus (RFC 7845), ~99 kbit/s
GET /live                                # JSON list of streamable players
```

Both accept an optional `v4/` prefix. The `server.password` is **always required**.

Enable it in your `config.ts`:

```ts
export default {
  // ...
  plugins: [
    {
      name: "live-stream",
      source: "local",
      path: "live-stream",
    },
  ],
  pluginConfig: {
    "live-stream": {
      // all fields are optional
      bindHost: "127.0.0.1",
      playerCheckMs: 5000,
      idleHeartbeatMs: 15000,
      maxClientBufferBytes: 524288,
      announceIntervalMs: 20000,
      opusBitrate: 96000,
      opusPagePackets: 4,
    },
  },
};
```

## Configuration

| Option                 | Default     | Description                                                                               |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `bindHost`             | `127.0.0.1` | Interface used by the internal worker → primary relay. Keep it on loopback.               |
| `playerCheckMs`        | `5000`      | How often to verify the player still exists; a stream lives as long as its player.        |
| `idleHeartbeatMs`      | `15000`     | Send one empty Ogg page this often while idle, so proxies see activity. `0` disables it.  |
| `maxClientBufferBytes` | `524288`    | Per-listener socket buffer ceiling. Frames are **dropped**, never queued, above this.     |
| `announceIntervalMs`   | `20000`     | How often playback workers re-advertise their relay endpoint to the primary.              |
| `opusBitrate`          | `96000`     | Target bitrate in bit/s.                                                                  |
| `opusPagePackets`      | `4`         | Opus packets per Ogg page (each packet is 20 ms), trading latency for container overhead. |

---

## Usage

### List players

```bash
curl -H "Authorization: youshallnotpass" http://localhost:3000/live
```

```json
{
  "count": 1,
  "players": [
    {
      "playerId": "sess-1:112233445566778899",
      "guildId": "112233445566778899",
      "workerId": 3,
      "scope": "worker",
      "tapReady": true
    }
  ],
  "endpoint": "/{sessionId}:{guildId}/stream",
  "format": { "...": "..." }
}
```

### Stream it

```bash
curl -H "Authorization: youshallnotpass" "http://localhost:3000/v4/sess-1:112233445566778899/stream"
```
