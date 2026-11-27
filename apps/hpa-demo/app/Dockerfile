# Base image pinned by digest (python:3.13-slim, digest read on docker01 on 2026-11-26)
FROM python@sha256:7249d5587b78209a006dc4a3b5340678f84ea729239193aa559962cd8c1fce50

LABEL org.opencontainers.image.source="https://github.com/zulhardy-lab/devops-projects"
LABEL org.opencontainers.image.description="Live dashboard and CPU-burning demo app for Kubernetes load balancing and autoscaling"

WORKDIR /app
COPY app.py .
COPY static/ static/

# Run as an unprivileged user, not root
USER 10001:10001
ENV PYTHONUNBUFFERED=1 PORT=8080
EXPOSE 8080
CMD ["python", "/app/app.py"]
