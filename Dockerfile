# CodeBuild passes public.ecr.aws/docker/library/node:22-bookworm-slim (no Docker Hub rate limits).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS frontend-deps
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app
# Railway injects same-named service variables as build args automatically; Vite only reads
# import.meta.env.VITE_* at build time, so these must be ARG/ENV here rather than runtime env vars.
# (On AWS, infra/aws/buildspec.yml passes them as --build-arg from the same secret the app reads.)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL
ARG VITE_APP_VERSION
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_APP_VERSION=${VITE_APP_VERSION}
COPY --from=frontend-deps /app/frontend/node_modules ./frontend/node_modules
COPY frontend ./frontend
RUN npm --prefix frontend run build

FROM ${NODE_IMAGE} AS backend-deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS backend-build
WORKDIR /app
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
RUN npm --prefix backend run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY backend/package*.json ./backend/
RUN npm --prefix backend ci --omit=dev && npm cache clean --force

COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

USER node
EXPOSE 4000
CMD ["node", "backend/dist/server.js"]
