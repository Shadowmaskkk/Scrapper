FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /app

COPY package*.json ./

RUN npm ci

RUN mkdir -p sessions logs

COPY . .

ENV PORT=3000
ENV HEADLESS=true
ENV LOG_LEVEL=info

EXPOSE 3000

CMD ["node", "mamba-scraper.js"]
