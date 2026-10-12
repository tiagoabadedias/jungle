#!/bin/bash
# Cria as filas do desafio (§10) e a fila de eventos de integração (§11).
# - A DLQ de uma fila FIFO precisa ser FIFO: o MiniStack não valida isso, a AWS sim.
# - O aws CLI da imagem ignora AWS_ENDPOINT_URL; sem --endpoint-url explícito as
#   chamadas vão para a AWS real. Por isso o wrapper abaixo.
set -euo pipefail

ACCOUNT=000000000000
REGION=us-east-1
ENDPOINT=http://localhost:4566

sqs() {
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
    aws --endpoint-url "$ENDPOINT" --region "$REGION" sqs "$@"
}

sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,MessageRetentionPeriod=1209600

sqs create-queue --queue-name wager-transactions.fifo --attributes '{
  "FifoQueue":"true",
  "VisibilityTimeout":"60",
  "ReceiveMessageWaitTimeSeconds":"20",
  "RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:'"$REGION"':'"$ACCOUNT"':wager-transactions-dlq.fifo\",\"maxReceiveCount\":\"5\"}"
}'

sqs create-queue --queue-name wallet-events.fifo --attributes FifoQueue=true
