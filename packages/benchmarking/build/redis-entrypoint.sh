#! /bin/bash

# linux commands to properly bootstrap:
ulimit -n 65535
sysctl vm.overcommit_memory=1

# start the redis node
redis-server ./redis.conf
