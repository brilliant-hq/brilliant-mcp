# The stdio MCP server of @brilliant-hq/mcp, for registries that build and
# inspect a server (initialize, tools/list). To design, run it on your own
# machine instead (see README, Install): it pairs with a Brilliant tab or the
# desktop app over 127.0.0.1, which a container cannot reach.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY lib ./lib
COPY clients.json LICENSE NOTICE ./
USER node
ENTRYPOINT ["node", "bin/brilliant-mcp.js"]
