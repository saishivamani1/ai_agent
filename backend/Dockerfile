# Use lightweight Python image
FROM python:3.11-slim

# Set workdir
WORKDIR /app

# Install dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY backend/ .

# Expose port (default Flask/FastAPI/Django is usually 5000 or 8000)
EXPOSE 8000

# Run app
CMD ["python", "main.py"]
