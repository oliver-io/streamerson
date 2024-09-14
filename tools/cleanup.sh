lerna exec 'rm -rf node_modules yarn.lock'
nx reset
docker rm --force $(docker ps --all -q)
docker rmi --force $(docker images --all -q)
docker system prune --volumes -a -f
rm -rf node_modules tmp dist
