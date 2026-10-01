# Plain node:24-slim: node:sqlite is built in and resvg ships a prebuilt
# binary, so there is no native build step and no toolchain in the image.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The link-preview fonts are OFL and fetched at build time rather than
# committed. Cinzel must be the static bold from upstream: resvg renders a
# variable font at its default instance and ignores font-weight. See fonts/README.md.
ADD https://github.com/NDISCOVER/Cinzel/raw/master/fonts/ttf/Cinzel-Bold.ttf fonts/Cinzel-Bold.ttf
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/alegreyasans/AlegreyaSans-Bold.ttf fonts/AlegreyaSans-Bold.ttf
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/IBMPlexMono-Medium.ttf fonts/IBMPlexMono-Medium.ttf
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/cinzel/OFL.txt fonts/OFL-Cinzel.txt
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/alegreyasans/OFL.txt fonts/OFL-AlegreyaSans.txt
ADD https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt fonts/OFL-IBMPlexMono.txt

COPY shared shared
COPY server server
COPY client client

# presets.json names real guild members, so it is never baked into an image.
# It lives on the volume and a missing file is not fatal.
RUN ln -s /data/presets.json presets.json && chmod 644 fonts/*

EXPOSE 3000
CMD ["node", "server/main.ts"]
