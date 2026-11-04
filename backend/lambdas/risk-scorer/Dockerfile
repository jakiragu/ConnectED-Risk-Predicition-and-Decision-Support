# The risk scorer as a Lambda container image (shap, numpy and dice-ml exceed the zip size limit).
# Models and their counterfactual statistics are not baked in: the scorer reads the published
# version from MODEL_BUCKET.
FROM public.ecr.aws/lambda/python:3.12
# shap imports numba, which caches compiled functions; only /tmp is writable in Lambda.
ENV NUMBA_CACHE_DIR=/tmp
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt
COPY handler.py model_store.py counterfactuals.py linear_model.py ${LAMBDA_TASK_ROOT}/
CMD ["handler.handler"]
