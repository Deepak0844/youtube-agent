# short-14 · Dev tip — "Why We Need Docker"

**Niche #5 (Dev / AI tips).** Canvas = ONE persistent dark terminal (GitHub-ink, from
`lib/terminal.tsx`), same device as short-4-git. One session: it runs on the laptop, breaks on
the server, gets fixed with a Dockerfile, then the twist explains WHY the fix is light (shares
the host kernel) instead of heavy (a full virtual machine).

## The promise

"It works on my machine" is the oldest complaint in software. Docker kills it by packaging the
app with its *exact* dependencies into an image that runs identically anywhere — and it's cheap
to run because a container shares the host's OS kernel instead of carrying a whole second OS
like a virtual machine does.

## Facts (verified against docker.com)

- A container shares the host machine's OS kernel; containers run as isolated processes in user
  space, several per machine.
- A VM includes a full copy of an operating system plus the app, binaries and libraries —
  typically **tens of GBs**.
- A container is typically **tens of MBs**.
- Docker container technology launched in **2013** as the open-source Docker Engine.

Source: https://www.docker.com/resources/what-container/

## Beat sheet

| Beat | Time | On screen | VO |
|------|------|-----------|----|
| HOOK | 0–4.0s | Frame 0 already resolved: terminal titled `ops@prod-server`, `docker run myapp` just printed green `Server running on :5000`, stamp "RUNS THE SAME EVERYWHERE" | "One command. The same app. Any machine, every time." |
| SETUP | 4.0–13.0s | Rewind: prompt flips to `you@laptop`, `python app.py` succeeds green. Prompt flips to `ops@prod-server`, same command prints red `ModuleNotFoundError: No module named 'flask'`. Kicker flips "IT WORKS ON MY MACHINE" → red "...NOT ON THIS ONE" | "On my laptop, this runs perfectly. I push the same code to the server. It crashes. Wrong Python version. A missing package." |
| REVEAL | 13.0–29.0s | A `Dockerfile` cascades in line by line (`FROM python:3.11`, `COPY . .`, `RUN pip install -r requirements.txt`, `CMD ["python","app.py"]`); `docker build -t myapp .` runs; `docker run myapp` on `ops@prod-server` now prints the same green success. Kicker "THE FIX: A DOCKERFILE" | "So we write a Dockerfile — exact versions, exact dependencies. Docker builds an image, and runs it in a container. A container shares the host's kernel, not a whole OS. That's why it starts in milliseconds, not minutes." |
| TWIST | 29.0–37.5s | Two stat chips stack: "VIRTUAL MACHINE — full OS, tens of GBs, slow boot" vs "CONTAINER — just the app, tens of MBs, instant" | "A virtual machine packs a whole OS. Tens of gigabytes. A container packs just the app. Tens of megabytes." |
| LOOP | 37.5–42.0s | Dissolve back to the hook's frozen success terminal + stamp (grow 1→1.06 == hook's settle start); no CTA | "Same image, same result, anywhere. That's why we need Docker." |

## Production notes

- One persistent terminal (no cuts): the prompt label (`you@laptop` vs `ops@prod-server`) is the
  continuity device that stands in for "two machines" without a second canvas — same trick
  short-4-git used for the before/after reflog state.
- The Dockerfile cascade and the final `docker run` success are the hero reveal; the stat-chip
  comparison in the twist is what actually answers "why Docker, not just a VM" — the real payoff
  of the title.
- Ending is the payoff line + seamless loop back to the hook's resolved terminal. No engagement CTA.
