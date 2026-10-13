FROM python:3.12-alpine
WORKDIR /app
COPY app.py /app/app.py
COPY static /app/static
COPY assets /app/assets
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["python3", "app.py"]
