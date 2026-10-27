FROM denoland/deno:2.9.5@sha256:b429777c3dcff34a6488f365a1537db1640b2d48379b60f5e6206be034472463

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libimage-exiftool-perl \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 5173
WORKDIR /app
ENV NODE_ENV=production
COPY ./backend/deno.lock /app/deno.lock
COPY ./backend/deno.json /app/deno.json
COPY ./backend/package.json /app/package.json
RUN deno install --frozen
COPY ./myceliasdk /myceliasdk
COPY ./backend/. /app/
CMD ["deno", "run", "-A", "server.ts", "serve", "--prod"]
