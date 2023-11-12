FROM redis:latest
COPY redis.conf /usr/local/bin/redis.conf
RUN chmod +r /usr/local/bin/redis.conf
WORKDIR /usr/local/bin
CMD redis-server ./redis.conf
