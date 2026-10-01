# syntax=docker/dockerfile:1.7
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
#
# Each is pinned to a commit and checksummed: resvg parses these in native
# code, so a changed upstream file must fail the build, not ship (#29). The
# hashes are the files production served when they were pinned. To update one,
# change the commit and the hash together.
ADD --checksum=sha256:0c23ec565db45c5508ee95889c60ad87debd167ca07167a43a5d68572b4e2eac \
    https://raw.githubusercontent.com/NDISCOVER/Cinzel/968d2554a12aec6afb495522c29046b080ea67c6/fonts/ttf/Cinzel-Bold.ttf fonts/Cinzel-Bold.ttf
ADD --checksum=sha256:a3055a1893759bdbd7504bb22abc583769e7974c49353176eac0b03792c9fb8e \
    https://raw.githubusercontent.com/google/fonts/414832ad3de91ca90fbea0d6cbf4aafa2ecc7804/ofl/alegreyasans/AlegreyaSans-Bold.ttf fonts/AlegreyaSans-Bold.ttf
ADD --checksum=sha256:a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755 \
    https://raw.githubusercontent.com/google/fonts/633f3200539c52ee0aba2dfd7f46921417a81877/ofl/ibmplexmono/IBMPlexMono-Medium.ttf fonts/IBMPlexMono-Medium.ttf
ADD --checksum=sha256:f2b3029aba64c378bf0963b62945eee15e564fe4330b934c8f2eb058282b5e83 \
    https://raw.githubusercontent.com/google/fonts/45071f07c63e863a539442ef3562b71ab1f147a6/ofl/cinzel/OFL.txt fonts/OFL-Cinzel.txt
ADD --checksum=sha256:0677891e6a143f297350d260ad766ad33bfc18ed5fa4f213acf648d6b597ec1a \
    https://raw.githubusercontent.com/google/fonts/b39cbbbbe16d82ef4ff19b950ddd5519541be8c5/ofl/alegreyasans/OFL.txt fonts/OFL-AlegreyaSans.txt
ADD --checksum=sha256:7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da \
    https://raw.githubusercontent.com/google/fonts/465b90c97b4de569e0b546bb2536900194cf7187/ofl/ibmplexmono/OFL.txt fonts/OFL-IBMPlexMono.txt

COPY shared shared
COPY server server
COPY client client

# The running commit, for the footer (#32). The wildcard lets the build work
# with no .git at all; only HEAD and the refs are in the context (see
# .dockerignore), and an unresolvable one just shows "dev". The hash is echoed
# so the build log says which commit it built.
COPY package.json .gi[t] /tmp/gitmeta/
RUN node server/version.ts --write /tmp/gitmeta > version.txt 2>/dev/null; \
    rm -rf /tmp/gitmeta; echo "version: $(cat version.txt)"

# presets.json names real guild members, so it is never baked into an image.
# It lives on the volume and a missing file is not fatal.
RUN ln -s /data/presets.json presets.json && chmod 644 fonts/*

EXPOSE 3000
CMD ["node", "server/main.ts"]
