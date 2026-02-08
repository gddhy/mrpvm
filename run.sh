#!/bin/sh
read -p "Please input commit: " info
git add .
git commit -m "${info}"
git pull origin master
git push origin master