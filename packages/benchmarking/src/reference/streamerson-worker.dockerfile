FROM node:20.7.0-bullseye-slim
WORKDIR ../../dist
RUN npm install
COPY . .
EXPOSE 4200
CMD [ "npm", "start:worker:prod" ]