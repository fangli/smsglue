FROM node:slim
ENV NODE_ENV production
WORKDIR /smsglue

# Copying all the files in our project
COPY . .

# Installing dependencies
RUN npm install

# Starting our application
CMD node index.js

# Exposing server port
EXPOSE 2777