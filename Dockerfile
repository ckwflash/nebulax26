FROM node:22-slim AS frontend
WORKDIR /frontend
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY trackaccess ./trackaccess
COPY PS1/01_data ./PS1/01_data
COPY PS1/03_submission_sample ./PS1/03_submission_sample
COPY outputs ./outputs
COPY --from=frontend /frontend/dist ./dist
ENV NIGHTSHIFT_DATA=/data/nightshift PYTHONUNBUFFERED=1
RUN useradd --create-home planner && mkdir -p /data/nightshift && chown -R planner:planner /data /app
USER planner
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn trackaccess.api:app --host 0.0.0.0 --port ${PORT:-8000}"]
