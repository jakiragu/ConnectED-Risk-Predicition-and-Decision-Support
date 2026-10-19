# The risk scorer as a Lambda container image (xgboost, numpy and dice-ml exceed the zip size limit).
# Models and their counterfactual statistics are not baked in: the scorer reads the published
# version from MODEL_BUCKET.
FROM public.ecr.aws/lambda/python:3.12
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt
COPY handler.py model_store.py counterfactuals.py ${LAMBDA_TASK_ROOT}/
CMD ["handler.handler"]
