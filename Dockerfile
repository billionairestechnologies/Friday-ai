FROM node:22-bookworm-slim AS frontend-deps
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app
# Railway injects same-named service variables as build args automatically; Vite only reads
# import.meta.env.VITE_* at build time, so these must be ARG/ENV here rather than runtime env vars.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
COPY --from=frontend-deps /app/frontend/node_modules ./frontend/node_modules
COPY frontend ./frontend
RUN npm --prefix frontend run build

FROM node:22-bookworm-slim AS backend-deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci

FROM node:22-bookworm-slim AS backend-build
WORKDIR /app
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
RUN npm --prefix backend run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY backend/package*.json ./backend/
RUN npm --prefix backend ci --omit=dev && npm cache clean --force

COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

USER node
EXPOSE 4000
CMD ["node", "backend/dist/server.js"]
