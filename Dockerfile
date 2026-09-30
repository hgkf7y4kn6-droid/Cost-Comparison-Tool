FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/hf-cache

# Tesseract for OCR on photos / scanned PDFs
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch first: the default wheel bundles CUDA and is several GB larger
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the CLIP model into the image so startup doesn't download it every deploy
RUN python -c "from transformers import CLIPModel, CLIPProcessor; \
m='openai/clip-vit-base-patch32'; CLIPModel.from_pretrained(m); CLIPProcessor.from_pretrained(m)"

COPY backend.py .

# Render injects PORT; default to 8000 for local `docker run`
CMD ["sh", "-c", "uvicorn backend:app --host 0.0.0.0 --port ${PORT:-8000}"]
