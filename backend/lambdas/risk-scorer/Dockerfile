# The risk scorer as a Lambda container image (xgboost and numpy exceed the zip size limit).
# Models are not baked in: the scorer reads the published version from MODEL_BUCKET.
FROM public.ecr.aws/lambda/python:3.12
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt
COPY handler.py model_store.py ${LAMBDA_TASK_ROOT}/
CMD ["handler.handler"]