FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py .
ENV PORT=8765
EXPOSE 8765
CMD ["python", "bot.py"]
