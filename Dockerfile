# MP4 Grabber Library: no npm dependencies, so the image is just Node + the app.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY extension ./extension
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 4321
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
