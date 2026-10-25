# Security policy

## The short version

The remote-control plugin gives whoever holds **both** the access link and the
access code full control of the agent on your computer — that includes running
commands in your workspace. Treat the two together as one secret.

| Credential | Where it lives | How to rotate it |
| --- | --- | --- |
| access link | the QR code and the *Copy link* button | change the relay URL or the device id |
| access code | `Settings → Remote Control`, the *Access code* block | **Change code** — old codes and unlocked phones stop working at once |
| relay token | the relay's `RELAY_TOKEN` and the plugin's state file | rotate the secret; every relay holding the old one is rejected |
| device credential | a cookie on the phone | remove the device, or clear the phone's cookies |

## What the relay can and cannot see

The relay is a tunnel, not a trusted party:

* It never receives a Harness credential. The launch token that lets a phone
  obtain a session cookie is injected by the **host**, on the way out.
* It sees the phone's HTTP traffic, because it has to replay it.
* It stores the device list, the phone list and the trust decisions in its own
  state file (`RELAY_STATE`). Keep that file readable by the relay's user only —
  it holds the phone credentials.

## Hardening a relay you expose to the internet

* Serve it over TLS. A plain HTTP relay leaks the session cookie to everyone on
  the path. `bootstrap.sh` puts nginx and a Let's Encrypt certificate in front of
  it.
* Keep the relay's port off the public internet — only nginx should reach it.
  `bootstrap.sh` binds it to `127.0.0.1`.
* Give the relay its own system user and let it write only its state directory.
* Rotate `RELAY_TOKEN` when someone leaves the team.

## Reporting a problem

Please report security issues privately through GitHub's
[security advisory](https://docs.github.com/en/code-security/security-advisories)
form for this repository rather than in a public issue.
