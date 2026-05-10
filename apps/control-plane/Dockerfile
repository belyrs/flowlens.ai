FROM node:22-alpine AS base
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/control-plane/package.json ./apps/control-plane/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json

RUN npm install

COPY . .

RUN npm run build -w @flowlens/shared-types && npm run build -w @flowlens/control-plane

EXPOSE 4000

CMD ["npm", "run", "start", "-w", "@flowlens/control-plane"]

