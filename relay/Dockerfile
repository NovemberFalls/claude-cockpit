FROM node:20-slim AS frontend-build

WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install
COPY dashboard/ ./
RUN npm run build

# ── Python runtime ──────────────────────────────────────

FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy relay server
COPY relay/ ./relay/

# Copy built dashboard
COPY --from=frontend-build /app/dashboard/dist ./dashboard/dist

# Create data directory
RUN mkdir -p /data

# Environment
ENV DATA_DIR=/data
ENV PORT=8430
ENV HOST=0.0.0.0

EXPOSE 8430

CMD ["python", "-m", "relay.main"]
