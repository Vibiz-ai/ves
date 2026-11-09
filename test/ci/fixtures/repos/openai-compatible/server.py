from fastapi import FastAPI
app = FastAPI()
@app.post('/v1/chat/completions')
def chat(): ...
