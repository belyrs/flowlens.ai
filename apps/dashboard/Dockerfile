FROM node:22-alpine AS base
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json

RUN npm install

COPY . .

RUN npm run build -w @flowlens/shared-types && npm run build -w @flowlens/dashboard

EXPOSE 3000

CMD ["npm", "run", "preview", "-w", "@flowlens/dashboard"]

