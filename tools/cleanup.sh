lerna exec 'rm -rf node_modules'
nx reset
docker system prune --volumes -a -f
rm -rf node_modules tmp dist
